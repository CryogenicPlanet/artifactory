import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { TestContext } from "vitest";
import { seedSession, sessionFetch } from "./fixtures/session.ts";
import { Generation } from "../src/generations.ts";

const execute = promisify(execFile);
const State = Schema.Struct({
	child: Schema.Struct({
		state: Schema.String,
		pid: Schema.NullOr(Schema.Int),
		generation: Schema.NullOr(Schema.Int),
		attempt: Schema.Int,
		error: Schema.NullOr(Schema.String),
		stderr: Schema.String,
	}),
	last_good: Schema.NullOr(Schema.Int),
});
const History = Schema.Struct({ items: Schema.Array(Generation), last_good: Schema.NullOr(Schema.Int) });
const entrySource = `import { message } from "./message.ts";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
 if (request.headers.get("x-boot-secret") !== process.env.BOOT_SECRET) return new Response(null, { status: 403 });
 const path = new URL(request.url).pathname;
 if (path === "/_kernel/control") return new Response("ok");
 if (path === "/health" || path === "/_kernel/ping") return new Response("ok",{headers:{"x-comms-writer-epoch":process.env.WRITER_EPOCH??"","x-comms-kernel-protocol":"2"}});
 if (path === "/crash") { setTimeout(() => process.exit(7), 10); return new Response("exiting"); }
 return Response.json({ message, content: await Bun.file("content.txt").text(), generation: process.env.GENERATION });
}});
console.log("COMMS_CHILD_PORT=" + server.port);
`;

async function fixture(test: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-generations-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const seed = join(root, "seed");
	const data = join(root, "data");
	await mkdir(seed);
	await writeFile(join(seed, "server.ts"), entrySource);
	await writeFile(join(seed, "message.ts"), 'export const message = "original";');
	await writeFile(join(seed, "content.txt"), "snapshot-content");
	return { seed, data, root };
}

async function sql(data: string, statement: string) {
	const result = await execute("bun", [
		join(import.meta.dirname, "fixtures/store.ts"),
		join(data, "boot.db"),
		statement,
	]);
	const value: unknown = JSON.parse(result.stdout);
	return value;
}

async function removeSourceSchema(data: string) {
	if (
		Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
			await sql(data, "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'"),
		).length > 0
	)
		await sql(data, "DELETE FROM settings WHERE key='source.watcher_baseline'");
	for (const table of [
		"child_attempts",
		"backups",
		"cutover",
		"source_changes",
		"versions",
		"source_batches",
		"seq",
		"events",
		"event_batches",
		"topic_moves",
		"topic_page_moves",
		"db_restore_requests",
		"enrollments",
		"tokens",
		"mint_receipts",
		"refresh_receipts",
		"refresh_idempotency",
	])
		await sql(data, `DROP TABLE ${table}`);
}

async function launch(
	test: TestContext,
	env: { seed: string; data: string; dependencies?: string; unavailableStore?: boolean },
) {
	const processHandle = spawn("bun", [join(import.meta.dirname, "fixtures/launcher.ts")], {
		env: {
			...process.env,
			ENTRY: join(env.seed, "server.ts"),
			DATA_DIR: env.data,
			DEPENDENCIES_DIRECTORY: env.dependencies,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const capture = (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-16384);
	};
	processHandle.stdout.on("data", capture);
	processHandle.stderr.on("data", capture);
	const stop = async () => {
		if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
		const exited = once(processHandle, "exit");
		processHandle.kill("SIGTERM");
		await Promise.race([
			exited,
			delay(4000).then(() => {
				if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGKILL");
			}),
		]);
		await exited;
	};
	test.onTestFinished(stop);
	let url = "";
	await expect
		.poll(
			() => {
				if (processHandle.exitCode !== null) throw new Error(output);
				url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
				return url;
			},
			{ timeout: 5000 },
		)
		.not.toBe("");
	const cookie = env.unavailableStore ? "" : (await seedSession(env.data)).cookie;
	const authenticatedFetch = sessionFetch(cookie);
	const state = async () =>
		Schema.decodeUnknownSync(State)(await (await authenticatedFetch(`${url}/_boot/status`)).json());
	const history = async () =>
		Schema.decodeUnknownSync(History)(await (await authenticatedFetch(`${url}/_boot/generations`)).json());
	return { url, stop, state, history, fetch: authenticatedFetch };
}

describe("durable boot generations in real Bun and SQLite", () => {
	it("executes only the snapshot, restarts it with broken or missing sources, and never overwrites edits", async (test) => {
		const env = await fixture(test);
		const first = await launch(test, env);
		await expect.poll(async () => (await first.state()).child.state).toBe("live");
		expect(await (await first.fetch(first.url)).json()).toEqual({
			message: "original",
			content: "snapshot-content",
			generation: "1",
		});
		const history = await first.history();
		expect(history.items).toMatchObject([{ n: 1, status: "live", good: 1, entry_file: "server.ts" }]);
		expect(await (await first.fetch(`${first.url}/api/generations`)).json()).toEqual(history);
		expect(await sql(env.data, "SELECT good FROM generations WHERE n = 1")).toEqual([{ good: 1 }]);
		await writeFile(join(env.data, "app/message.ts"), "invalid source !!!");
		await writeFile(join(env.data, "app/content.txt"), "mutable-content");
		await rm(env.seed, { recursive: true });
		// Shell edits neither reserve a new generation nor create an automatic history batch.
		await delay(1250);
		expect((await first.history()).items).toHaveLength(1);
		expect(await sql(env.data, "SELECT * FROM source_batches")).toEqual([]);
		expect(await (await first.fetch(first.url)).json()).toEqual({
			message: "original",
			content: "snapshot-content",
			generation: "1",
		});
		await first.stop();
		const restarted = await launch(test, env);
		await expect.poll(async () => (await restarted.state()).child.state).toBe("live");
		expect(await (await restarted.fetch(restarted.url)).json()).toEqual({
			message: "original",
			content: "snapshot-content",
			generation: "1",
		});
		expect(await readFile(join(env.data, "app/message.ts"), "utf8")).toBe("invalid source !!!");
		expect((await restarted.history()).items).toHaveLength(1);
		await restarted.stop();
		await rm(join(env.data, "app"), { recursive: true });
		const missing = await launch(test, env);
		await expect.poll(async () => (await missing.state()).child.state).toBe("live");
		expect((await missing.state()).child.generation).toBe(1);
	});

	it("restarts the same good snapshot after every healthy run instead of counting lifetime crashes", async (test) => {
		const env = await fixture(test);
		const app = await launch(test, env);
		await expect.poll(async () => (await app.state()).child.state).toBe("live");
		for (let crashes = 1; crashes <= 4; crashes++) {
			await app.fetch(`${app.url}/crash`);
			await expect
				.poll(() => sql(env.data, "SELECT count(*) AS count FROM child_attempts WHERE closed=1"))
				.toEqual([{ count: crashes }]);
			await expect
				.poll(async () => (await app.state()).child)
				.toMatchObject({ state: "live", attempt: 1, generation: 1 });
		}
		expect((await app.history()).items).toMatchObject([{ n: 1, status: "live", good: 1 }]);
		expect(
			await sql(env.data, "SELECT event FROM events WHERE json_extract(event, '$.type')='generation.failed'"),
		).toEqual([]);
	});

	it("does not resurrect an exited child when health finishes during inherited stderr drain", async (test) => {
		const env = await fixture(test);
		const helper = `
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
 process.kill(Number(process.env.PARENT_PID), "SIGTERM");
 await Bun.sleep(50);
 return new Response("ok",{headers:{"x-comms-writer-epoch":process.env.WRITER_EPOCH??"","x-comms-kernel-protocol":"2"}});
}});
console.log("COMMS_CHILD_PORT=" + server.port);
setTimeout(() => process.exit(0), 400);
`;
		await writeFile(
			join(env.seed, "server.ts"),
			`
const helper = Bun.spawn([process.execPath, "-e", ${JSON.stringify(helper)}], {
 env: { PARENT_PID: String(process.pid), WRITER_EPOCH: process.env.WRITER_EPOCH }, stdin: "ignore", stdout: "inherit", stderr: "inherit"
});
await helper.exited;
`,
		);
		const app = await launch(test, env);
		await expect
			.poll(async () => (await app.history()).items[0], { timeout: 5000 })
			.toMatchObject({ status: "failed", good: 0 });
		await expect
			.poll(async () => (await app.state()).child, { timeout: 5000 })
			.toMatchObject({ state: "failed", attempt: 3 });
		await delay(500);
		expect((await app.state()).child).toMatchObject({ state: "failed", attempt: 3 });
		expect((await app.history()).items[0]).toMatchObject({ status: "failed", good: 0 });
		expect((await app.fetch(app.url)).status).toBe(503);
	});

	it("records a broken first startup and a new durable id after repairing the editable tree", async (test) => {
		const env = await fixture(test);
		await writeFile(
			join(env.seed, "server.ts"),
			'console.error("secret=" + process.env.BOOT_SECRET); throw new Error("broken first generation");',
		);
		const broken = await launch(test, env);
		await expect
			.poll(async () => (await broken.state()).child, { timeout: 6000 })
			.toMatchObject({ state: "failed", attempt: 3 });
		await expect.poll(async () => (await broken.history()).items[0]).toMatchObject({ n: 1, status: "failed", good: 0 });
		expect((await broken.history()).items[0]?.stderr).toContain("broken first generation");
		expect((await broken.history()).items[0]?.stderr).toContain("secret=[redacted]");
		expect((await broken.fetch(`${broken.url}/health`)).status).toBe(200);
		expect((await broken.fetch(broken.url)).status).toBe(503);
		await broken.stop();
		await writeFile(join(env.data, "app/server.ts"), entrySource);
		const repaired = await launch(test, env);
		await expect.poll(async () => (await repaired.state()).child.state).toBe("live");
		expect((await repaired.history()).items).toMatchObject([
			{ n: 2, good: 1 },
			{ n: 1, good: 0 },
		]);
		expect(await (await repaired.fetch(repaired.url)).json()).toMatchObject({ generation: "2", message: "original" });
	});

	it("refuses newer schemas without changing the database and keeps diagnostics available", async (test) => {
		const env = await fixture(test);
		await mkdir(env.data);
		await sql(env.data, "PRAGMA user_version = 99");
		const before = await readFile(join(env.data, "boot.db"));
		const app = await launch(test, { ...env, unavailableStore: true });
		await expect.poll(async () => (await fetch(`${app.url}/_boot/status`)).status).toBe(503);
		expect(await (await fetch(`${app.url}/_boot/status`)).text()).not.toContain("BootSchemaTooNew");
		expect((await fetch(`${app.url}/_boot`)).status).toBe(200);
		expect((await app.fetch(`${app.url}/health`)).status).toBe(200);
		expect((await app.fetch(app.url)).status).toBe(503);
		expect((await fetch(`${app.url}/_boot/generations`)).status).toBe(503);
		await app.stop();
		expect(await readFile(join(env.data, "boot.db"))).toEqual(before);
		expect(await sql(env.data, "PRAGMA user_version")).toEqual([{ user_version: 99 }]);
	});

	it("never reseeds after a completed initial copy followed by dependency failure", async (test) => {
		const env = await fixture(test);
		const first = await launch(test, { ...env, dependencies: join(env.root, "absent-dependencies") });
		await expect.poll(async () => (await first.state()).child.state).toBe("failed");
		expect((await first.history()).items[0]?.snapshot_dir).toBeNull();
		expect(await sql(env.data, "SELECT value FROM settings WHERE key = 'app_seeded'")).toEqual([{ value: "1" }]);
		await first.stop();
		await rm(join(env.data, "app"), { recursive: true });
		await writeFile(join(env.seed, "message.ts"), 'export const message = "replacement seed";');
		const next = await launch(test, env);
		await expect.poll(async () => (await next.state()).child.state).toBe("failed");
		expect((await next.state()).child.error).toContain("refusing to replace it with seed");
		expect((await next.fetch(next.url)).status).toBe(503);
	});

	it("migrates the original schema and preserves its known-good snapshot", async (test) => {
		const env = await fixture(test);
		const first = await launch(test, env);
		await expect.poll(async () => (await first.state()).child.state).toBe("live");
		await first.stop();
		await sql(env.data, "DROP TABLE settings");
		await sql(env.data, "DROP TABLE passkeys");
		await sql(env.data, "DROP TABLE auth_challenges");
		await sql(env.data, "DROP TABLE sessions");
		await sql(env.data, "DROP TABLE staging");
		await sql(env.data, "DROP TABLE edit_lock");
		await removeSourceSchema(env.data);
		await sql(env.data, "DROP TABLE public_paths");
		await sql(env.data, "PRAGMA user_version = 1");
		await rm(join(env.data, "app"), { recursive: true });
		await rm(env.seed, { recursive: true });
		const migrated = await launch(test, env);
		await expect.poll(async () => (await migrated.state()).child.state).toBe("live");
		expect((await migrated.state()).child.generation).toBe(1);
		expect(await sql(env.data, "PRAGMA user_version")).toEqual([{ user_version: 14 }]);
		expect(await sql(env.data, "SELECT value FROM settings WHERE key = 'app_seeded'")).toEqual([{ value: "1" }]);
	}, 15000);

	it("migrates schema two without losing seed or generation metadata", async (test) => {
		const env = await fixture(test);
		const first = await launch(test, env);
		await expect.poll(async () => (await first.state()).child.state).toBe("live");
		await first.stop();
		await sql(env.data, "DROP TABLE passkeys");
		await sql(env.data, "DROP TABLE auth_challenges");
		await sql(env.data, "DROP TABLE sessions");
		await sql(env.data, "DROP TABLE staging");
		await sql(env.data, "DROP TABLE edit_lock");
		await removeSourceSchema(env.data);
		await sql(env.data, "DROP TABLE public_paths");
		await sql(env.data, "PRAGMA user_version = 2");
		const migrated = await launch(test, env);
		await expect.poll(async () => (await migrated.state()).child.state).toBe("live");
		expect((await migrated.state()).child.generation).toBe(1);
		expect(await sql(env.data, "PRAGMA user_version")).toEqual([{ user_version: 14 }]);
		expect(await sql(env.data, "SELECT value FROM settings WHERE key = 'app_seeded'")).toEqual([{ value: "1" }]);
		expect(await sql(env.data, "SELECT * FROM edit_lock")).toEqual([]);
	}, 15000);

	it("migrates schema three while preserving active edit ownership and staged deletions", async (test) => {
		const env = await fixture(test);
		const first = await launch(test, env);
		await expect.poll(async () => (await first.state()).child.state).toBe("live");
		await first.stop();
		await sql(env.data, "DROP TABLE passkeys");
		await sql(env.data, "DROP TABLE auth_challenges");
		await sql(env.data, "DROP TABLE sessions");
		await removeSourceSchema(env.data);
		await sql(env.data, "ALTER TABLE staging DROP COLUMN mode");
		await sql(env.data, "DROP TABLE public_paths");
		await sql(env.data, "PRAGMA user_version = 3");
		await sql(
			env.data,
			`INSERT INTO edit_lock
			(singleton, id, holder_family, agent, since, expires, ttl_seconds, note)
			VALUES (1, 'saved-lock', 'family-one', 'codex', 0, 9999999999999, 900, 'unfinished edit')`,
		);
		await sql(env.data, "INSERT INTO staging VALUES ('saved-lock', 'app/obsolete.ts', NULL, NULL, 0)");
		const migrated = await launch(test, env);
		await expect.poll(async () => (await migrated.state()).child.state).toBe("live");
		expect((await migrated.state()).child.generation).toBe(1);
		expect(await sql(env.data, "PRAGMA user_version")).toEqual([{ user_version: 14 }]);
		expect(await sql(env.data, "SELECT id, holder_family FROM edit_lock")).toEqual([
			{ id: "saved-lock", holder_family: "family-one" },
		]);
		expect(await sql(env.data, "SELECT path, content FROM staging")).toEqual([
			{ path: "app/obsolete.ts", content: null },
		]);
		for (const table of ["passkeys", "auth_challenges"])
			expect(await sql(env.data, `SELECT * FROM ${table}`)).toEqual([]);
	});

	it("migrates schema four preserving auth, active ownership and the staged overlay", async (test) => {
		const env = await fixture(test);
		const first = await launch(test, env);
		await expect.poll(async () => (await first.state()).child.state).toBe("live");
		await first.stop();
		await removeSourceSchema(env.data);
		await sql(env.data, "ALTER TABLE staging DROP COLUMN mode");
		await sql(env.data, "INSERT INTO passkeys VALUES ('saved-key','public-key',4,'[]','laptop',12)");
		await sql(
			env.data,
			"INSERT INTO edit_lock (singleton,id,holder_family,agent,since,expires,ttl_seconds,note) VALUES (1,'saved-lock','family','codex',0,9999999999999,900,'unfinished')",
		);
		await sql(env.data, "INSERT INTO staging VALUES ('saved-lock','app/old.ts',NULL,NULL,0)");
		const sessions = await sql(env.data, "SELECT id,hash,expires_at FROM sessions");
		await sql(env.data, "ALTER TABLE sessions DROP COLUMN last_seen_at");
		await sql(env.data, "DROP TABLE public_paths");
		await sql(env.data, "PRAGMA user_version = 4");
		const migrated = await launch(test, env);
		await expect.poll(async () => (await migrated.state()).child.state).toBe("live");
		expect(await sql(env.data, "PRAGMA user_version")).toEqual([{ user_version: 14 }]);
		expect(await sql(env.data, "SELECT id,counter,label FROM passkeys")).toEqual([
			{ id: "saved-key", counter: 4, label: "laptop" },
		]);
		expect(await sql(env.data, "SELECT id,hash,expires_at FROM sessions")).toEqual(
			expect.arrayContaining([...Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(sessions)]),
		);
		expect(await sql(env.data, "SELECT id,holder_family FROM edit_lock")).toEqual([
			{ id: "saved-lock", holder_family: "family" },
		]);
		expect(await sql(env.data, "SELECT path,content,mode FROM staging")).toEqual([
			{ path: "app/old.ts", content: null, mode: null },
		]);
	});
	it("keeps auth and saved-good serving during source recovery conflict, blocks new snapshots, then replays before clearing pin", async (test) => {
		const env = await fixture(test);
		const first = await launch(test, env);
		await expect.poll(async () => (await first.state()).child.state).toBe("live");
		await first.stop();
		const sha = (text: string) => createHash("sha256").update(text).digest("hex");
		await sql(
			env.data,
			"INSERT INTO edit_lock (singleton,id,holder_family,agent,since,expires,ttl_seconds,note,cutover_in_flight) VALUES (1,'pending-lock','family','codex',0,9999999999999,900,'publishing',1)",
		);
		await sql(
			env.data,
			"INSERT INTO staging (lock_id,path,content,sha,at) VALUES ('pending-lock','app/content.txt',NULL,NULL,0)",
		);
		await sql(env.data, "INSERT INTO source_batches VALUES ('pending','pending-lock','codex',0,'publishing')");
		await sql(
			env.data,
			`INSERT INTO source_changes (batch,path,before,before_sha,before_mode,desired,desired_sha,desired_mode) VALUES ('pending','app/content.txt',CAST('snapshot-content' AS BLOB),'${sha("snapshot-content")}',416,CAST('changed' AS BLOB),'${sha("changed")}',416)`,
		);
		await writeFile(join(env.data, "app/content.txt"), "external");
		const conflicted = await launch(test, env);
		await expect.poll(async () => (await conflicted.state()).child.state).toBe("live");
		const status = await (await conflicted.fetch(`${conflicted.url}/_boot/status`)).json();
		expect(status).toMatchObject({
			authenticated: true,
			source_recovery_error: expect.stringContaining("external_conflict"),
		});
		expect((await fetch(`${conflicted.url}/_boot/status`)).status).toBe(401);
		expect((await fetch(`${conflicted.url}/auth/login`)).status).toBe(200);
		expect(await (await conflicted.fetch(conflicted.url)).json()).toMatchObject({ content: "snapshot-content" });
		expect(await sql(env.data, "SELECT id FROM edit_lock")).toEqual([{ id: "pending-lock" }]);
		await conflicted.stop();
		await sql(env.data, "UPDATE generations SET good=0");
		const blocked = await launch(test, env);
		await expect.poll(async () => (await blocked.state()).child.state).toBe("failed");
		expect((await blocked.history()).items).toHaveLength(1);
		await blocked.stop();
		await writeFile(join(env.data, "app/content.txt"), "snapshot-content");
		const recovered = await launch(test, env);
		await expect.poll(async () => (await recovered.state()).child.state).toBe("live");
		expect(await (await recovered.fetch(recovered.url)).json()).toMatchObject({ content: "changed", generation: "2" });
		expect(await sql(env.data, "SELECT * FROM edit_lock")).toEqual([]);
		expect(await sql(env.data, "SELECT * FROM staging")).toEqual([]);
		expect(await sql(env.data, "SELECT state FROM source_batches WHERE id='pending'")).toEqual([
			{ state: "published" },
		]);
	});

	it("falls back to an older good snapshot after the newest snapshot exhausts its attempts", async (test) => {
		const env = await fixture(test);
		const first = await launch(test, env);
		await expect.poll(async () => (await first.state()).child.state).toBe("live");
		await first.stop();
		// Model two previously accepted snapshots, then damage the newer one's entry on disk.
		await cp(join(env.data, "gen/1"), join(env.data, "gen/2"), { recursive: true });
		await sql(
			env.data,
			`INSERT INTO generations (n, snapshot_dir, entry_file, status, good, started_at, healthy_at)
 SELECT 2, replace(snapshot_dir, '/1/source', '/2/source'), entry_file, 'retired', 1, started_at, healthy_at
 FROM generations WHERE n = 1`,
		);
		await writeFile(join(env.data, "gen/2/source/server.ts"), 'throw new Error("damaged latest snapshot");');
		await writeFile(join(env.data, "app/message.ts"), "broken editable source");
		const app = await launch(test, env);
		await expect
			.poll(async () => (await app.state()).child, { timeout: 5000 })
			.toMatchObject({ state: "live", generation: 1 });
		expect((await app.history()).items).toMatchObject([
			{ n: 2, good: 1, status: "failed" },
			{ n: 1, good: 1, status: "live" },
		]);
		expect(await (await app.fetch(app.url)).json()).toMatchObject({ generation: "1", message: "original" });
		const previousPid = (await app.state()).child.pid;
		await app.fetch(`${app.url}/crash`);
		await expect
			.poll(async () => {
				const child = (await app.state()).child;
				return child.state === "live" && child.pid !== previousPid;
			})
			.toBe(true);
		await expect.poll(async () => (await app.state()).child).toMatchObject({ state: "live", generation: 1 });
		expect(
			await sql(
				env.data,
				"SELECT json_extract(event, '$.generation') AS generation, json_extract(event, '$.payload.reason') AS reason, json_extract(event, '$.payload.attempts') AS attempts FROM events WHERE json_extract(event, '$.type')='generation.failed'",
			),
		).toEqual([{ generation: 2, reason: "startup_failures", attempts: 3 }]);
	});

	it("refuses a corrupted stored entry instead of executing outside its snapshot", async (test) => {
		const env = await fixture(test);
		const first = await launch(test, env);
		await expect.poll(async () => (await first.state()).child.state).toBe("live");
		await first.stop();
		await sql(env.data, "UPDATE generations SET entry_file = '../../../app/server.ts'");
		const app = await launch(test, env);
		await expect.poll(async () => (await app.state()).child).toMatchObject({ state: "failed", attempt: 3 });
		expect((await app.state()).child.error).toContain("Invalid stored snapshot or entry path");
		expect((await app.history()).items[0]?.good).toBe(1);
		expect((await app.fetch(app.url)).status).toBe(503);
	});

	it("rejects overlapping seed/data directories without recursively copying storage", async (test) => {
		const env = await fixture(test);
		const app = await launch(test, { ...env, data: join(env.seed, "data") });
		await expect.poll(async () => (await app.state()).child.state).toBe("failed");
		expect((await app.state()).child.error).toContain("Source and destination must be separate");
		expect((await app.history()).items[0]).toMatchObject({ n: 1, good: 0, status: "failed" });
		expect((await app.fetch(`${app.url}/health`)).status).toBe(200);
	});
});
