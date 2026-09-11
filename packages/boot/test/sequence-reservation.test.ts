import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
const execute = promisify(execFile);
async function store(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-events-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const run = async (input: unknown) => {
		const { stdout } = await execute("bun", [
			join(import.meta.dirname, "fixtures/events-store.ts"),
			root,
			JSON.stringify(input),
		]);
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
	};
	const sql = async (statement: string, name = "boot.db") => {
		const { stdout } = await execute("bun", [
			join(import.meta.dirname, "fixtures/store.ts"),
			join(root, name),
			statement,
		]);
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
	};
	return { root, run, sql };
}

it("commits exactly one trailing diagnostic with reservation, hides it until abort, and never reuses its sequence", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	await app.sql(
		"CREATE TRIGGER fail_audit BEFORE INSERT ON events WHEN json_extract(NEW.event,'$.type')='seq.reserved' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
	);
	expect(await app.run({ op: "reserve", transaction: "once", count: 2 })).toMatchObject({ _tag: "Failure" });
	expect(await app.sql("SELECT id FROM event_batches")).toEqual([]);
	expect(await app.run({ op: "state" })).toMatchObject({
		success: { next: 1, published_through: 0, pending_id: null },
	});
	await app.sql("DROP TRIGGER fail_audit");
	expect(await app.run({ op: "reserve", transaction: "once", count: 2 })).toMatchObject({
		success: { from: 1, to: 2 },
	});
	const bytes = await app.sql("SELECT seq,transaction_id,event FROM events");
	// Every invocation opens a fresh boot-store connection, including the pending retry.
	expect(await app.run({ op: "reserve", transaction: "once", count: 2 })).toMatchObject({
		success: { from: 1, to: 2 },
	});
	expect(await app.sql("SELECT seq,transaction_id,event FROM events")).toEqual(bytes);
	expect(await app.run({ op: "query", since: 0 })).toMatchObject({ success: { items: [], cursor: 0 } });
	await app.run({ op: "abort", transaction: "once" });
	expect(await app.run({ op: "query", since: 0 })).toMatchObject({
		success: {
			cursor: 3,
			items: [
				{
					seq: 3,
					type: "seq.reserved",
					actor: "boot",
					payload: { transaction: "once", attempt: "attempt", from: 1, to: 2, purpose: "mutation" },
				},
			],
		},
	});
	expect(await app.run({ op: "reserve", transaction: "once", count: 2 })).toMatchObject({
		_tag: "Failure",
		failure: { code: "reservation_conflict" },
	});
	expect(await app.run({ op: "reserve", transaction: "next", count: 1 })).toMatchObject({
		success: { from: 4, to: 4 },
	});
});

it("reserves space for both the diagnostic and next pointer at safe-integer exhaustion", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	await app.sql(`UPDATE seq SET next=${Number.MAX_SAFE_INTEGER - 1},published_through=${Number.MAX_SAFE_INTEGER - 2}`);
	const before = await app.sql("SELECT * FROM seq");
	expect(await app.run({ op: "reserve", transaction: "too-high" })).toMatchObject({
		_tag: "Failure",
		failure: { code: "sequence_exhausted" },
	});
	expect(await app.sql("SELECT * FROM seq")).toEqual(before);
	expect(await app.sql("SELECT seq FROM events")).toEqual([]);
	expect(await app.sql("SELECT id FROM event_batches")).toEqual([]);
	await app.sql(`UPDATE seq SET next=${Number.MAX_SAFE_INTEGER - 2},published_through=${Number.MAX_SAFE_INTEGER - 3}`);
	expect(await app.run({ op: "reserve", transaction: "last" })).toMatchObject({
		success: { from: Number.MAX_SAFE_INTEGER - 2, to: Number.MAX_SAFE_INTEGER - 2 },
	});
	await app.run({ op: "abort", transaction: "last" });
	expect(await app.run({ op: "state" })).toMatchObject({
		success: { next: Number.MAX_SAFE_INTEGER, published_through: Number.MAX_SAFE_INTEGER - 1 },
	});
	expect(await app.run({ op: "reserve", transaction: "exhausted" })).toMatchObject({
		_tag: "Failure",
		failure: { code: "sequence_exhausted" },
	});
});

it("recovers a legacy pending reservation without synthesizing missing audit history", async (test) => {
	const app = await store(test);
	await app.run({ op: "recover", epoch: "old" });
	await app.sql("INSERT INTO event_batches VALUES('legacy','old',1,2,'pending')");
	await app.sql("UPDATE seq SET next=3,pending_id='legacy',pending_attempt='old',pending_from=1,pending_to=2");
	expect(await app.run({ op: "recover", epoch: "replacement" })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT state FROM event_batches")).toEqual([{ state: "aborted" }]);
	expect(await app.sql("SELECT seq FROM events")).toEqual([]);
	expect(await app.run({ op: "reserve", epoch: "replacement", transaction: "new" })).toMatchObject({
		success: { from: 3, to: 3 },
	});
	expect(await app.sql("SELECT seq FROM events")).toEqual([{ seq: 4 }]);
});

it("never resurrects a retained-away diagnostic when its published app batch is replayed", async (test) => {
	const app = await store(test);
	await app.run({ op: "reserve", transaction: "published" });
	const event = {
		seq: 1,
		at: 1,
		type: "test.changed",
		level: "info",
		actor: "test",
		instance: null,
		generation: 0,
		request_id: null,
		topic: null,
		message_id: null,
		payload: {},
	};
	const batch = { transaction: "published", from: 1, to: 1, events: [event] };
	expect(await app.run({ op: "append", batch })).toMatchObject({ _tag: "Success" });
	await app.sql("DELETE FROM events WHERE seq=2");
	const retained = await app.sql("SELECT seq,event FROM events");
	expect(await app.run({ op: "append", epoch: "restarted", batch })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT seq,event FROM events")).toEqual(retained);
	expect(await app.run({ op: "state" })).toMatchObject({ success: { next: 3, published_through: 2 } });
});
