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
	{ timeout: 25000 },
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
			(await authenticated(`${app.url}/api/fs/app/server.ts?reload=0`, { method: "PUT", body: source })).status,
		).toBe(200);
		const reload = await authenticated(`${app.url}/api/reload`, { method: "POST", body: "{}" });
		expect(reload.status).toBe(503);
		expect(await attempts()).toEqual([{ opened: 1, closed: 0 }]);
		expect(await sql("comms.db", "SELECT epoch FROM kernel_writer")).toEqual(epoch);
		expect(await sql("boot.db", "SELECT cutover_in_flight FROM edit_lock")).toEqual([{ cutover_in_flight: 0 }]);
		await stop(app.handle);
		const restarted = await launch();
		await expect
			.poll(async () => (await state(restarted.url)).child.error, { timeout: 8000 })
			.toContain("child_closure_unproven");
		expect((await fetch(`${restarted.url}/_boot`)).status).toBe(200);
		expect((await authenticated(`${restarted.url}/api/fs/app/server.ts`)).status).toBe(200);
		expect(await attempts()).toEqual([{ opened: 1, closed: 0 }]);
		expect(await sql("comms.db", "SELECT epoch FROM kernel_writer")).toEqual(epoch);
		expect(alive(owner.pid)).toBe(true);
	},
);
