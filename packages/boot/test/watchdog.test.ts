import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { seedSession, sessionFetch } from "./fixtures/session.ts";

const Identity = Schema.Struct({ pid: Schema.Int, keeper: Schema.Int });
const Status = Schema.Struct({
	child: Schema.Struct({ state: Schema.String, pid: Schema.NullOr(Schema.Int), error: Schema.NullOr(Schema.String) }),
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

async function launch(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-watchdog-"));
	const seed = join(root, "seed");
	const data = join(root, "data");
	await mkdir(seed);
	await copyFile(join(import.meta.dirname, "fixtures/watchdog.ts"), join(seed, "server.ts"));
	const handle = spawn("bun", [join(import.meta.dirname, "fixtures/launcher.ts")], {
		env: { ...process.env, ENTRY: join(seed, "server.ts"), DATA_DIR: data },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const orphans: number[] = [];
	test.onTestFinished(async () => {
		try {
			if (handle.exitCode === null && handle.signalCode === null) {
				handle.kill("SIGTERM");
				await expect.poll(() => handle.exitCode !== null || handle.signalCode !== null, { timeout: 8000 }).toBe(true);
			}
		} finally {
			if (handle.exitCode === null && handle.signalCode === null) handle.kill("SIGKILL");
			for (const pid of orphans) {
				if (alive(pid)) process.kill(pid, "SIGKILL");
				await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
			}
			await rm(root, { recursive: true, force: true });
		}
	});
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
	const { cookie } = await seedSession(data);
	const authenticated = sessionFetch(cookie);
	const state = async () => Schema.decodeUnknownSync(Status)(await (await authenticated(`${url}/_boot/status`)).json());
	await expect.poll(async () => (await state()).child.state, { timeout: 8000 }).toBe("live");
	const identity = async () => Schema.decodeUnknownSync(Identity)(await (await authenticated(url)).json());
	const execute = promisify(execFile);
	const sql = async (database: string, statement: string): Promise<unknown> => {
		const { stdout } = await execute("bun", [
			join(import.meta.dirname, "fixtures/store.ts"),
			join(data, database),
			statement,
		]);
		return JSON.parse(stdout);
	};
	return { data, seed, url, authenticated, state, identity, sql, orphans };
}

it("does not let an old pending watchdog probe remove a replacement route", { timeout: 25000 }, async (test) => {
	const app = await launch(test);
	const old = await app.identity();
	expect((await app.authenticated(`${app.url}/delay-ping`)).status).toBe(200);
	await expect
		.poll(
			async () => {
				try {
					return await readFile(join(app.data, `ping-${old.pid}`), "utf8");
				} catch {
					return "";
				}
			},
			{ timeout: 3000 },
		)
		.toBe("waiting");
	expect((await app.authenticated(`${app.url}/api/lock`, { method: "POST", body: "{}" })).status).toBe(200);
	const source = await readFile(join(app.seed, "server.ts"), "utf8");
	expect(
		(
			await app.authenticated(`${app.url}/api/fs/app/server.ts?reload=0`, {
				method: "PUT",
				body: `${source}\n// replacement`,
			})
		).status,
	).toBe(200);
	const reload = await app.authenticated(`${app.url}/api/reload`, { method: "POST", body: "{}" });
	expect(reload.status, await reload.text()).toBe(200);
	const replacement = await app.identity();
	expect(replacement.pid).not.toBe(old.pid);
	await expect.poll(() => alive(old.pid), { timeout: 5000 }).toBe(false);
	await delay(6500); // Pass the old probe deadline and multiple replacement probes.
	expect((await app.state()).child).toMatchObject({ state: "live", pid: replacement.pid });
	expect(await app.identity()).toEqual(replacement);
	expect(alive(replacement.pid)).toBe(true);
});

it("fails closed when a live child loses its keeper without closure proof", { timeout: 20000 }, async (test) => {
	const app = await launch(test);
	const old = await app.identity();
	app.orphans.push(old.pid);
	const epoch = await app.sql("comms.db", "SELECT epoch FROM kernel_writer");
	process.kill(old.keeper, "SIGKILL");
	await expect.poll(async () => (await app.state()).child.error, { timeout: 8000 }).toContain("child_closure_unproven");
	await delay(1500);
	expect(alive(old.pid)).toBe(true);
	expect((await app.authenticated(app.url)).status).toBe(503);
	expect((await app.authenticated(`${app.url}/api/fs/app/server.ts`)).status).toBe(200);
	expect((await fetch(`${app.url}/_boot`)).status).toBe(200);
	expect((await fetch(`${app.url}/_boot/status`)).status).toBe(401);
	expect(await app.sql("boot.db", "SELECT opened,closed FROM child_attempts")).toEqual([{ opened: 1, closed: 0 }]);
	expect(await app.sql("comms.db", "SELECT epoch FROM kernel_writer")).toEqual(epoch);
});

it(
	"records keeper closure before restarting a child whose private probe times out",
	{ timeout: 20000 },
	async (test) => {
		const app = await launch(test);
		const old = await app.identity();
		expect((await app.authenticated(`${app.url}/delay-ping`)).status).toBe(200);
		await expect
			.poll(
				async () => {
					const state = (await app.state()).child;
					return state.state === "live" && state.pid !== old.pid;
				},
				{ timeout: 12000 },
			)
			.toBe(true);
		expect(alive(old.pid)).toBe(false);
		const replacement = await app.identity();
		expect(replacement.pid).not.toBe(old.pid);
		expect(await app.sql("boot.db", "SELECT opened,closed FROM child_attempts ORDER BY closed DESC")).toEqual([
			{ opened: 1, closed: 1 },
			{ opened: 1, closed: 0 },
		]);
		expect((await app.state()).child.error).toBeNull();
	},
);
