import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, type TestContext } from "vitest";
import { seedSession, sessionFetch } from "./fixtures/session.ts";

const execute = promisify(execFile);
async function fixture(test: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-legacy-refusal-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "pages/old"), { recursive: true });
	await writeFile(join(root, "pages/old/page.md"), "preserved page");
	await writeFile(join(root, "comms.db"), "app store must not be opened");
	const inspect = async () => {
		const value: unknown = JSON.parse(
			(await execute("bun", [join(import.meta.dirname, "fixtures/topic-move-recovery.ts"), root])).stdout,
		);
		return value;
	};
	const sql = async (statement: string) => {
		const value: unknown = JSON.parse(
			(await execute("bun", [join(import.meta.dirname, "fixtures/store.ts"), join(root, "boot.db"), statement])).stdout,
		);
		return value;
	};
	await inspect();
	return { root, inspect, sql };
}

it.for(["topic_moves", "topic_page_moves", "TOPIC_MOVES"])(
	"detects %s without interpreting or changing any table rows",
	async (table, test) => {
		const app = await fixture(test);
		expect(await app.inspect()).toBe(false);
		await app.sql(`CREATE TABLE ${table}(evidence TEXT)`);
		expect(await app.inspect()).toBe(true);
		await app.sql(`INSERT INTO ${table} VALUES('opaque historical evidence')`);
		const before = await readFile(join(app.root, "boot.db"));
		expect(await app.inspect()).toBe(true);
		expect(await readFile(join(app.root, "boot.db"))).toEqual(before);
		expect(await readFile(join(app.root, "comms.db"), "utf8")).toBe("app store must not be opened");
	},
);

it("refuses pre-cut legacy schemas before migration and still upgrades clean pre-cut stores", async (test) => {
	for (const legacy of [true, false]) {
		const app = await fixture(test);
		await app.sql("ALTER TABLE edit_lock DROP COLUMN reset_pin");
		await app.sql("PRAGMA user_version=15");
		if (legacy) await app.sql("CREATE TABLE topic_moves(evidence TEXT)");
		const before = await readFile(join(app.root, "boot.db"));
		if (legacy) {
			await expect(app.inspect()).rejects.toMatchObject({
				stdout: expect.stringContaining("topic_move_recovery_required"),
			});
			expect(await readFile(join(app.root, "boot.db"))).toEqual(before);
			expect(await app.sql("PRAGMA user_version")).toEqual([{ user_version: 15 }]);
			expect(await app.sql("SELECT name FROM pragma_table_info('edit_lock') WHERE name='reset_pin'")).toEqual([]);
		} else {
			expect(await app.inspect()).toBe(false);
			expect(await app.sql("PRAGMA user_version")).toEqual([{ user_version: 16 }]);
			expect(await app.sql("SELECT name FROM pragma_table_info('edit_lock') WHERE name='reset_pin'")).toEqual([
				{ name: "reset_pin" },
			]);
		}
	}
});

it("keeps authentication available while refusing legacy stores across restart, retaining old events and all recovery evidence", async (test) => {
	const app = await fixture(test);
	await app.sql("CREATE TABLE topic_moves(id TEXT,state TEXT)");
	await app.sql("CREATE TABLE topic_page_moves(id TEXT,state TEXT)");
	await app.sql("INSERT INTO topic_moves VALUES('move','prepared')");
	await app.sql("INSERT INTO topic_page_moves VALUES('move','publishing')");
	await app.sql(
		'INSERT INTO events(seq,transaction_id,event) VALUES(1,\'move\',\'{"seq":1,"at":1,"type":"topic.moved","payload":{"from":"old","to":"new"}}\')',
	);
	await app.sql("INSERT INTO event_batches VALUES('move','old-attempt',1,1,'published')");
	await app.sql("UPDATE seq SET next=2,published_through=1");
	const evidence = () =>
		Promise.all([
			app.sql("SELECT * FROM topic_moves"),
			app.sql("SELECT * FROM topic_page_moves"),
			app.sql("SELECT * FROM event_batches"),
			app.sql("SELECT * FROM events WHERE seq=1"),
		]);
	const before = await evidence();
	const cookie = (await seedSession(app.root)).cookie;
	const authenticated = sessionFetch(cookie);
	for (let restart = 0; restart < 2; restart++) {
		await rm(join(app.root, "maintenance-observed"), { force: true });
		const child = spawn("bun", [join(import.meta.dirname, "fixtures/legacy-refusal-launcher.ts")], {
			env: { ...process.env, ENTRY: join(app.root, "missing-seed/server.ts"), DATA_DIR: app.root },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const capture = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-16384);
		};
		child.stdout.on("data", capture);
		child.stderr.on("data", capture);
		test.onTestFinished(() => {
			child.kill("SIGKILL");
		});
		let url = "";
		await expect
			.poll(
				() => {
					if (child.exitCode !== null) throw new Error(output);
					url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
					return url;
				},
				{ timeout: 5000 },
			)
			.not.toBe("");
		// Before any request, only the scoped byte-cap loop measures boot database allocation.
		await expect.poll(() => readFile(join(app.root, "maintenance-observed"), "utf8").catch(() => "")).toBe("measured");
		await expect
			.poll(async () => (await authenticated(`${url}/_boot/status`)).json(), { timeout: 5000 })
			.toMatchObject({
				child: { state: "failed", pid: null, error: expect.stringContaining("topic_move_recovery_required") },
			});
		expect((await fetch(`${url}/_boot/status`)).status).toBe(401);
		expect((await fetch(`${url}/auth/login`)).status).toBe(200);
		expect((await fetch(`${url}/health`)).status).toBe(200);
		expect((await authenticated(url)).status).toBe(503);
		const exited = once(child, "exit");
		child.kill("SIGTERM");
		await exited;
		expect(await evidence()).toEqual(before);
		expect(await app.sql("SELECT * FROM generations")).toEqual([]);
		expect(await app.sql("SELECT * FROM child_attempts")).toEqual([]);
		expect(await readFile(join(app.root, "comms.db"), "utf8")).toBe("app store must not be opened");
		expect(await readFile(join(app.root, "pages/old/page.md"), "utf8")).toBe("preserved page");
		await expect(stat(join(app.root, "pages/new"))).rejects.toMatchObject({ code: "ENOENT" });
	}
}, 15000);
