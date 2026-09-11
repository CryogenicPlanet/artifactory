import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";

const execute = promisify(execFile);
const day = 86_400_000;
const now = 100 * day;
async function store(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-retention-"));
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
	const prune = (loop = false) => invoke("event-retention", { now, loop });
	const sql = async (statement: string) => {
		const { stdout } = await execute("bun", [
			join(import.meta.dirname, "fixtures/store.ts"),
			join(root, "boot.db"),
			statement,
		]);
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
	};
	await run({ op: "init" });
	return { run, prune, sql };
}
const event = (seq: number, type: string, age: number) => ({
	seq,
	at: now - age,
	type,
	level: "info",
	actor: "boot",
	instance: null,
	generation: 1,
	request_id: null,
	topic: null,
	message_id: null,
	payload: {},
});

it("keeps exact age boundaries and unpublished rows, preserving receipts and cursors across prune/replay/restart", async (test) => {
	const app = await store(test);
	await app.run({ op: "reserve", transaction: "first", count: 4 });
	const batch = {
		transaction: "first",
		from: 1,
		to: 4,
		events: [
			event(1, "http.request", 7 * day + 1),
			event(2, "message.created", 30 * day),
			event(3, "http.request", 7 * day),
			event(4, "message.created", 30 * day + 1),
		],
	};
	await app.run({ op: "append", batch });
	await app.run({ op: "reserve", transaction: "pending", count: 1 });
	await app.run({ op: "boot", event: event(6, "http.request", 40 * day) });
	const before = await app.sql("SELECT * FROM seq");
	expect(await app.prune()).toMatchObject({ exit: "Success", deleted: 2 });
	expect(await app.sql("SELECT seq FROM events ORDER BY seq")).toEqual([{ seq: 2 }, { seq: 3 }, { seq: 6 }]);
	expect(await app.sql("SELECT * FROM seq")).toEqual(before);
	expect(await app.run({ op: "append", epoch: "replacement", batch })).toMatchObject({ _tag: "Success" });
	expect(await app.run({ op: "query", since: 0, limit: 1 })).toMatchObject({
		success: { items: [{ seq: 2 }], cursor: 2 },
	});
	expect(await app.run({ op: "query", since: 3 })).toMatchObject({ success: { items: [], cursor: 3 } });
	await app.run({ op: "abort", transaction: "pending" });
	expect(await app.prune()).toMatchObject({ deleted: 1 });
	expect(await app.sql("SELECT seq FROM events ORDER BY seq")).toEqual([{ seq: 2 }, { seq: 3 }]);
	expect(await app.sql("SELECT id,state FROM event_batches ORDER BY id")).toEqual([
		{ id: "first", state: "published" },
		{ id: "pending", state: "aborted" },
	]);
}, 15000);

it("commits bounded chunks, rolls back a failed chunk, and safely resumes after restart", async (test) => {
	const app = await store(test);
	await app.sql(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<600)
		INSERT INTO events(seq,transaction_id,event) SELECT n,NULL,json_set('${JSON.stringify(event(0, "http.request", 8 * day))}','$.seq',n) FROM numbers`);
	await app.sql("UPDATE seq SET next=601,published_through=600");
	await app.sql(
		"CREATE TRIGGER fail_retention BEFORE DELETE ON events WHEN old.seq=300 BEGIN SELECT RAISE(ABORT,'injected'); END",
	);
	expect(await app.prune()).toMatchObject({ exit: "Failure" });
	expect(await app.sql("SELECT count(*) AS count,min(seq) AS first FROM events")).toEqual([{ count: 344, first: 257 }]);
	await app.sql("DROP TRIGGER fail_retention");
	expect(await app.prune()).toMatchObject({ exit: "Success", deleted: 344 });
	expect(await app.run({ op: "query", since: 256 })).toMatchObject({ success: { items: [], cursor: 256 } });
	expect(await app.run({ op: "reserve", transaction: "next" })).toMatchObject({ success: { from: 601, to: 601 } });
}, 15000);

it("reads persisted policy each pass, refuses malformed policy, retries hourly and remains interruptible", async (test) => {
	const app = await store(test);
	await app.run({ op: "boot", event: event(1, "http.request", 8 * day) });
	await app.run({ op: "boot", event: event(2, "message.created", 2 * day) });
	await app.sql(`INSERT INTO settings VALUES('event_retention','{"http_request_days":10,"other_days":1}')`);
	expect(await app.prune()).toMatchObject({ deleted: 1 });
	expect(await app.sql("SELECT seq FROM events")).toEqual([{ seq: 1 }]);
	await app.sql(`UPDATE settings SET value='{"http_request_days":0,"other_days":1}' WHERE key='event_retention'`);
	expect(await app.prune()).toMatchObject({ exit: "Failure" });
	expect(await app.sql("SELECT seq FROM events")).toEqual([{ seq: 1 }]);
	expect(await app.prune(true)).toMatchObject({ exit: "Failure", interrupted: true, hours: 2 });
	expect(await app.sql("SELECT seq FROM events")).toEqual([]);
}, 15000);
