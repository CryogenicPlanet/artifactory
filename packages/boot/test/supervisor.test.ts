import { sourcePut } from "./fixtures/source-put.ts";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { seedSession, sessionFetch } from "./fixtures/session.ts";

const Owner = Schema.Struct({ pid: Schema.Int, keeper: Schema.Int, port: Schema.Int });
const Status = Schema.Struct({
	child: Schema.Struct({ state: Schema.String, attempt: Schema.Int, error: Schema.NullOr(Schema.String) }),
});

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

it(
	"blocks retry, source reload and restart when startup loses its keeper's closure proof",
	// Two boot lifetimes and authenticated recovery retries retain the six-second keeper-proof check.
	{ timeout: 60000 },
	async (test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-startup-closure-"));
		const seed = join(root, "seed");
		const data = join(root, "data");
		const processes: ReturnType<typeof spawn>[] = [];
		let owner: typeof Owner.Type | undefined;
		const stop = async (handle: ReturnType<typeof spawn>) => {
			if (handle.exitCode !== null || handle.signalCode !== null) return;
			handle.kill("SIGTERM");
			await expect.poll(() => handle.exitCode !== null || handle.signalCode !== null, { timeout: 5000 }).toBe(true);
		};
		test.onTestFinished(async () => {
			try {
				for (const handle of processes) {
					try {
						await stop(handle);
					} finally {
						if (handle.exitCode === null && handle.signalCode === null) handle.kill("SIGKILL");
					}
				}
			} finally {
				// Only the child created and reported by this disposable fixture is deliberately orphaned.
				if (owner && alive(owner.pid)) {
					const pid = owner.pid;
					process.kill(pid, "SIGKILL");
					await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
				}
				await rm(root, { recursive: true, force: true });
			}
		});
		await mkdir(seed);
		await copyFile(join(import.meta.dirname, "fixtures/keeper-startup.ts"), join(seed, "server.ts"));
		const launch = async () => {
			const handle = spawn("bun", [join(import.meta.dirname, "fixtures/launcher.ts")], {
				env: { ...process.env, ENTRY: join(seed, "server.ts"), DATA_DIR: data },
				stdio: ["ignore", "pipe", "pipe"],
			});
			processes.push(handle);
			let output = "";
			const capture = (chunk: Buffer) => {
				output = (output + chunk.toString()).slice(-16384);
			};
			handle.stdout.on("data", capture);
			handle.stderr.on("data", capture);
			let url = "";
			await expect
				.poll(
					() => {
						url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
						return url;
					},
					{ timeout: 5000 },
				)
				.not.toBe("");
			return { handle, url };
		};
		const execute = promisify(execFile);
		const sql = async (database: string, statement: string): Promise<unknown> => {
			const { stdout } = await execute("bun", [
				join(import.meta.dirname, "fixtures/store.ts"),
				join(data, database),
				statement,
			]);
			return JSON.parse(stdout);
		};
		const app = await launch();
		const { cookie } = await seedSession(data);
		const authenticated = sessionFetch(cookie);
		const state = async (url = app.url) =>
			Schema.decodeUnknownSync(Status)(await (await authenticated(`${url}/_boot/status`)).json());
		await expect
			.poll(
				async () => {
					try {
						owner = Schema.decodeSync(Schema.fromJsonString(Owner))(
							await readFile(join(data, "keeper-startup.json"), "utf8"),
						);
						return true;
					} catch {
						return false;
					}
				},
				{ timeout: 5000 },
			)
			.toBe(true);
		if (!owner) throw new Error("Missing first child identity");
		process.kill(owner.keeper, "SIGKILL");
		await expect.poll(async () => (await state()).child.error, { timeout: 7000 }).toContain("child_closure_unproven");
		await delay(1000); // Longer than both ordinary startup retry backoffs.
		expect((await state()).child).toMatchObject({ state: "failed", attempt: 1 });
		expect(alive(owner.pid)).toBe(true);
		const attempts = () => sql("boot.db", "SELECT opened,closed FROM child_attempts");
		expect(await attempts()).toEqual([{ opened: 1, closed: 0 }]);
		const epoch = await sql("comms.db", "SELECT epoch FROM kernel_writer");
		expect((await fetch(`${app.url}/_boot`)).status).toBe(200);
		expect((await fetch(`${app.url}/_boot/status`)).status).toBe(401);
		expect((await authenticated(app.url)).status).toBe(503);
		expect((await authenticated(`${app.url}/api/fs/app/server.ts`)).status).toBe(200);
		expect((await authenticated(`${app.url}/api/lock`, { method: "POST", body: "{}" })).status).toBe(200);
		const source = await readFile(join(seed, "server.ts"), "utf8");
		expect(
			(
				await sourcePut(
					`${app.url}/api/fs/app/server.ts?reload=0`,
					{
						method: "PUT",
						body: `${source}\n// staged repair`,
					},
					authenticated,
				)
			).status,
		).toBe(200);
		const reload = await authenticated(`${app.url}/api/reload`, { method: "POST", body: "{}" });
		expect({ status: reload.status, body: await reload.json() }).toMatchObject({
			status: 409,
			body: { error: { code: "child_closure_unproven", retriable: false } },
		});
		expect(await attempts()).toEqual([{ opened: 1, closed: 0 }]);
		expect(await sql("comms.db", "SELECT epoch FROM kernel_writer")).toEqual(epoch);
		expect(await sql("boot.db", "SELECT cutover_in_flight FROM edit_lock")).toEqual([{ cutover_in_flight: 0 }]);
		await stop(app.handle);
		await sql("boot.db", "UPDATE edit_lock SET expires=0");
		const lockBefore = await sql("boot.db", "SELECT * FROM edit_lock");
		const stagedBefore = await sql("boot.db", "SELECT lock_id,path,hex(content) AS content,sha,at,mode FROM staging");
		const restarted = await launch();
		await expect
			.poll(async () => (await state(restarted.url)).child.error, { timeout: 8000 })
			.toContain("child_closure_unproven");
		expect((await fetch(`${restarted.url}/_boot`)).status).toBe(200);
		const inspected = await authenticated(`${restarted.url}/api/fs/app/server.ts`);
		expect(inspected.status).toBe(200);
		expect(await inspected.text()).toBe(source);
		for (const path of ["app/", "app/server.ts?history=1"])
			expect((await authenticated(`${restarted.url}/api/fs/${path}`)).status).toBe(200);
		const lockRead = await authenticated(`${restarted.url}/api/lock`);
		expect({ status: lockRead.status, body: await lockRead.json() }).toMatchObject({
			status: 200,
			body: { lock: { expires: 0 } },
		});
		// Diagnostic reads never expire the old editor or discard its staging.
		expect(await sql("boot.db", "SELECT * FROM edit_lock")).toEqual(lockBefore);
		expect(await sql("boot.db", "SELECT lock_id,path,hex(content) AS content,sha,at,mode FROM staging")).toEqual(
			stagedBefore,
		);
		const acquired = await authenticated(`${restarted.url}/api/lock`, { method: "POST", body: "{}" });
		const acquiredBody: unknown = await acquired.json();
		expect({ status: acquired.status, body: acquiredBody }).toMatchObject({
			status: 200,
			body: { lock_committed: true, recovery: { status: "failed", error: { code: "recovery_failed" } } },
		});
		const newLock = Schema.decodeUnknownSync(Schema.Struct({ lock: Schema.Struct({ id: Schema.String }) }))(
			acquiredBody,
		).lock;
		expect(lockBefore).not.toMatchObject([{ id: newLock.id }]);
		expect(await sql("boot.db", "SELECT id FROM edit_lock")).toEqual([{ id: newLock.id }]);
		// Explicit acquisition expires the old unpinned overlay despite the separate closure failure.
		expect(await sql("boot.db", "SELECT * FROM staging")).toEqual([]);
		const held = await sql("boot.db", "SELECT * FROM edit_lock");
		const unsigned = await authenticated(`${restarted.url}/api/lock?break=1`, {
			method: "DELETE",
			body: JSON.stringify({ id: newLock.id }),
		});
		expect({ status: unsigned.status, body: await unsigned.json() }).toMatchObject({
			status: 401,
			body: { error: { code: "assertion_invalid" } },
		});
		expect(await sql("boot.db", "SELECT * FROM edit_lock")).toEqual(held);
		const released = await authenticated(`${restarted.url}/api/lock`, { method: "DELETE" });
		expect({ status: released.status, body: await released.json() }).toMatchObject({
			status: 200,
			body: { lock: null, lock_committed: true, recovery: { status: "failed", error: { code: "recovery_failed" } } },
		});
		for (const [path, method, body, status, code, retriable] of [
			["fs/app/server.ts?reload=0", "PUT", "refused source mutation", 503, "editing_unavailable", true],
			["fs/pages/diagnostic.md", "PUT", "refused page mutation", 503, "editing_unavailable", true],
			["reload", "POST", "{}", 503, "editing_unavailable", true],
			["revert", "POST", "{}", 409, "child_closure_unproven", false],
		] as const) {
			const response = await authenticated(`${restarted.url}/api/${path}`, { method, body });
			const actual: unknown = await response.json();
			expect({ path, status: response.status, body: actual }).toMatchObject({
				path,
				status,
				body: { error: { code, retriable, message: expect.any(String), hint: expect.any(String) } },
			});
		}
		expect(await sql("boot.db", "SELECT * FROM edit_lock")).toEqual([]);
		expect(await sql("boot.db", "SELECT * FROM staging")).toEqual([]);
		expect(await sql("boot.db", "SELECT * FROM source_batches")).toEqual([]);
		expect(await sql("boot.db", "SELECT * FROM source_changes")).toEqual([]);
		expect(await readFile(join(data, "app/server.ts"), "utf8")).toBe(source);
		expect(await attempts()).toEqual([{ opened: 1, closed: 0 }]);
		expect(await sql("comms.db", "SELECT epoch FROM kernel_writer")).toEqual(epoch);
		expect(alive(owner.pid)).toBe(true);
	},
);
