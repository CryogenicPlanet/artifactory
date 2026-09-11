import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";

const execute = promisify(execFile);
async function store(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-event-storage-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const invoke = async (fixture: string, input: unknown) => {
		const { stdout } = await execute("bun", [
			join(import.meta.dirname, `fixtures/${fixture}.ts`),
			root,
			JSON.stringify(input),
		]);
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
	};
	const run = (input: unknown) => invoke("events-store", input);
	const prune = (capacity = 1_000_000, unavailable = false) => invoke("event-storage", { capacity, unavailable });
	const sql = async (statement: string) => {
		const { stdout } = await execute("bun", [
			join(import.meta.dirname, "fixtures/store.ts"),
			join(root, "boot.db"),
			statement,
		]);
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
	};
	await run({ op: "init" });
	const seed = async (count: number) => {
		await sql(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<${count})
		INSERT INTO events(seq,transaction_id,event) SELECT n,NULL,json_set('${JSON.stringify(event(0))}','$.seq',n) FROM numbers`);
		await sql(`UPDATE seq SET next=${count + 1},published_through=${count}`);
	};
	return { root, run, prune, sql, seed, legacy: () => invoke("event-storage", { capacity: 1_000_000, legacy: true }) };
}
const event = (seq: number) => ({
	seq,
	at: 1,
	type: "http.request",
	level: "info",
	actor: "boot",
	instance: null,
	generation: 1,
	request_id: null,
	topic: null,
	message_id: null,
	payload: { body: "x".repeat(8192) },
});

it("evicts published pages including index allocation, preserves replay receipts, and shrinks physical storage", async (test) => {
	const app = await store(test);
	await app.seed(512);
	await app.run({ op: "reserve", transaction: "app", count: 1 });
	const batch = { transaction: "app", from: 513, to: 513, events: [event(513)] };
	await app.run({ op: "append", batch });
	await app.sql("PRAGMA wal_checkpoint(TRUNCATE)");
	const before = (await stat(join(app.root, "boot.db"))).size;
	const state = await app.sql("SELECT * FROM seq");
	const result = await app.prune();
	expect(result).toMatchObject({
		initial: { _tag: "Failure" },
		status: { status: "within_budget", limit_bytes: 100_000 },
		admission: { _tag: "Success" },
	});
	expect(await app.sql("SELECT * FROM seq")).toEqual(state);
	expect(await app.sql("SELECT id,state FROM event_batches")).toEqual([{ id: "app", state: "published" }]);
	const retained = await app.sql("SELECT seq FROM events");
	expect(await app.run({ op: "append", epoch: "restarted", batch })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT seq FROM events")).toEqual(retained);
	await app.sql("PRAGMA wal_checkpoint(TRUNCATE)");
	expect((await stat(join(app.root, "boot.db"))).size).toBeLessThan(before / 4);
	expect(await app.sql("SELECT freelist_count<25 AS freed FROM pragma_freelist_count")).toEqual([{ freed: 1 }]);
	const pages = await app.sql(
		"SELECT sum(pgsize)<=100000 AS within_budget FROM dbstat WHERE aggregate=TRUE AND name IN (SELECT name FROM sqlite_schema WHERE tbl_name='events')",
	);
	expect(pages).toEqual([{ within_budget: 1 }]);
});

// Twenty fresh Bun/SQLite processes exercise persisted admission across restarts; Linux exceeded the default 5s.
it("reports protected excess and refuses new admission while leaving pending rows and allocation untouched", async (test) => {
	const app = await store(test);
	await app.run({ op: "reserve", transaction: "pending", count: 1 });
	for (let n = 0; n < 12; n++) await app.run({ op: "boot", event: event(n) });
	const before = await app.sql("SELECT * FROM seq");
	expect(await app.prune()).toMatchObject({
		status: { status: "over_budget", reason: "no_prunable_events", deleted: 0 },
		admission: { _tag: "Failure", failure: { code: "event_storage_over_budget" } },
	});
	expect(await app.sql("SELECT * FROM seq")).toEqual(before);
	expect(await app.sql("SELECT count(*) AS count FROM events")).toEqual([{ count: 12 }]);
	await app.run({ op: "abort", transaction: "pending" });
	expect(await app.prune()).toMatchObject({ status: { status: "within_budget" }, admission: { _tag: "Success" } });
}, 15000);

it("limits each pass, rolls back a failed chunk, and recovers on another process without touching receipt tables", async (test) => {
	const app = await store(test);
	await app.seed(2304);
	await app.sql("INSERT INTO event_batches VALUES('retained','old',1,1,'published')");
	await app.sql(
		"CREATE TRIGGER fail_prune BEFORE DELETE ON events WHEN old.seq=300 BEGIN SELECT RAISE(ABORT,'injected'); END",
	);
	expect(await app.prune()).toMatchObject({ status: { status: "unavailable" }, admission: { _tag: "Failure" } });
	expect(await app.sql("SELECT min(seq) AS first,count(*) AS count FROM events")).toEqual([
		{ first: 257, count: 2048 },
	]);
	await app.sql("DROP TRIGGER fail_prune");
	await app.sql("UPDATE seq SET published_through=0");
	expect(await app.prune()).toMatchObject({ status: { status: "over_budget", deleted: 0 } });
	await app.sql("UPDATE seq SET published_through=2304");
	expect(await app.prune()).toMatchObject({ status: { status: "over_budget", deleted: 2048 } });
	for (let pass = 0; pass < 3; pass++) await app.prune();
	expect(await app.prune()).toMatchObject({ status: { status: "within_budget", deleted: 0 } });
	expect(await app.sql("SELECT id FROM event_batches")).toEqual([{ id: "retained" }]);
	expect(await app.prune(1_000_000, true)).toMatchObject({
		status: { status: "unavailable", reason: "measurement_failed" },
	});
});

it("stops a large pass after 2048 deletions and reports remaining pressure", async (test) => {
	const app = await store(test);
	await app.seed(2304);
	expect(await app.prune()).toMatchObject({
		status: { status: "over_budget", reason: "pruning_in_progress", deleted: 2048 },
	});
	expect(await app.sql("SELECT min(seq) AS first,count(*) AS count FROM events")).toEqual([
		{ first: 2049, count: 256 },
	]);
	expect(await app.prune()).toMatchObject({ status: { status: "over_budget", deleted: 256 } });
	for (let pass = 0; pass < 3; pass++) await app.prune();
	expect(await app.prune()).toMatchObject({ status: { status: "within_budget", deleted: 0 } });
});

it("counts index root pages even when no event payload can be pruned", async (test) => {
	const app = await store(test);
	expect(await app.prune(80_000)).toMatchObject({
		status: { status: "over_budget", reason: "no_prunable_events", limit_bytes: 8_000, deleted: 0 },
		admission: { _tag: "Failure", failure: { code: "event_storage_over_budget" } },
	});
});

it("keeps physical WAL pressure over budget while a reader pins old pages, then reclaims after it closes", async (test) => {
	const app = await store(test);
	const reader = spawn(
		"bun",
		[join(import.meta.dirname, "fixtures/event-storage-reader.ts"), join(app.root, "boot.db")],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	test.onTestFinished(() => {
		reader.kill("SIGTERM");
	});
	await once(reader.stdout, "data");
	await app.seed(512);
	const wal = (await stat(join(app.root, "boot.db-wal"))).size;
	expect(wal).toBeGreaterThan(100_000);
	expect(await app.prune()).toMatchObject({ status: { status: "over_budget" }, admission: { _tag: "Failure" } });
	expect((await stat(join(app.root, "boot.db-wal"))).size).toBeGreaterThanOrEqual(wal);
	const exited = once(reader, "exit");
	reader.kill("SIGTERM");
	await exited;
	for (let pass = 0; pass < 3; pass++) await app.prune();
	expect(await app.prune()).toMatchObject({
		status: { status: "within_budget", wal_bytes: 0 },
		admission: { _tag: "Success" },
	});
});

it("retains legacy free pages as physical pressure without running an unsafe full vacuum", async (test) => {
	const app = await store(test);
	await app.legacy();
	await app.seed(512);
	await app.sql("INSERT INTO settings VALUES('protected_receipt','durable')");
	expect(await app.prune()).toMatchObject({
		status: { status: "over_budget", reason: "reclaim_unavailable", incremental_reclaim: false },
		admission: { _tag: "Failure" },
	});
	expect(await app.sql("SELECT value FROM settings WHERE key='protected_receipt'")).toEqual([{ value: "durable" }]);
	expect(await app.prune()).toMatchObject({
		status: { status: "over_budget", reason: "reclaim_unavailable", deleted: 0 },
	});
});

it("reads configured budgets on each pass and fails closed for malformed settings", async (test) => {
	const app = await store(test);
	await app.sql(
		`INSERT INTO settings VALUES('storage_policy','{"backup_percent":20,"event_percent":1,"headroom_percent":5}')`,
	);
	expect(await app.prune()).toMatchObject({ status: { limit_bytes: 10_000, status: "over_budget" } });
	await app.sql(`UPDATE settings SET value='invalid' WHERE key='storage_policy'`);
	expect(await app.prune()).toMatchObject({ status: { status: "unavailable" }, admission: { _tag: "Failure" } });
});

it("charges the old main-file tail while a reader prevents checkpointing a logical shrink", async (test) => {
	const app = await store(test);
	await app.seed(512);
	await app.sql("PRAGMA wal_checkpoint(TRUNCATE)");
	const before = (await stat(join(app.root, "boot.db"))).size;
	const reader = spawn(
		"bun",
		[join(import.meta.dirname, "fixtures/event-storage-reader.ts"), join(app.root, "boot.db")],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	test.onTestFinished(() => {
		reader.kill("SIGTERM");
	});
	await once(reader.stdout, "data");
	const result = await app.prune();
	expect(result).toMatchObject({ status: { status: "over_budget" }, admission: { _tag: "Failure" } });
	expect(result).toHaveProperty("status.retained_database_bytes", expect.any(Number));
	const usage = Schema.decodeUnknownSync(
		Schema.Struct({
			status: Schema.Struct({
				retained_database_bytes: Schema.Int,
				other_database_bytes: Schema.Int,
				allocated_bytes: Schema.Int,
			}),
		}),
	)(result).status;
	expect(usage.retained_database_bytes).toBeGreaterThan(0);
	expect(usage.allocated_bytes + usage.other_database_bytes).toBeGreaterThanOrEqual(before);
});
