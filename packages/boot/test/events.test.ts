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
const event = (seq: number) => ({
	seq,
	at: 1,
	type: "message.created",
	level: "info",
	actor: "rahul",
	instance: "s_1",
	generation: 1,
	request_id: "r_1",
	topic: "project/thread",
	message_id: `m_${seq}`,
	payload: { body: "hello" },
});

it("holds higher boot events behind an exact batch, preserves paging cursors, and validates replay", async (test) => {
	const app = await store(test);
	expect(await app.run({ op: "reserve", transaction: "tx", count: 2 })).toMatchObject({
		_tag: "Success",
		success: { from: 1, to: 2 },
	});
	expect(await app.run({ op: "reserve", transaction: "tx", count: 2 })).toMatchObject({
		_tag: "Success",
		success: { from: 1, to: 2 },
	});
	expect(await app.run({ op: "reserve", transaction: "other" })).toMatchObject({
		_tag: "Failure",
		failure: { code: "publication_pending" },
	});
	await app.run({ op: "boot", event: { ...event(999), type: "generation.live", actor: "boot" } });
	expect(await app.run({ op: "query", since: 0 })).toMatchObject({ success: { items: [], cursor: 0 } });
	const batch = { transaction: "tx", from: 1, to: 2, events: [event(1), event(2)] };
	expect(await app.run({ op: "append", batch: { ...batch, events: [event(1)] } })).toMatchObject({
		_tag: "Failure",
		failure: { code: "batch_invalid" },
	});
	expect(await app.run({ op: "append", epoch: "wrong", batch })).toMatchObject({ _tag: "Failure" });
	expect(await app.run({ op: "append", batch })).toMatchObject({ success: { published_through: 3 } });
	expect(await app.run({ op: "query", since: 0, limit: 1 })).toMatchObject({
		success: { items: [event(1)], cursor: 1 },
	});
	expect(await app.run({ op: "query", since: 1 })).toMatchObject({
		success: { items: [event(2), { seq: 3 }], cursor: 3 },
	});
	expect(await app.run({ op: "append", epoch: "new-attempt", batch })).toMatchObject({ _tag: "Success" });
	expect(
		await app.run({
			op: "append",
			epoch: "new-attempt",
			batch: { ...batch, events: [{ ...event(1), payload: {} }, event(2)] },
		}),
	).toMatchObject({ _tag: "Failure", failure: { code: "batch_conflict" } });
	await app.sql("DELETE FROM events WHERE seq=1");
	await app.run({ op: "append", epoch: "another", batch });
	expect(await app.sql("SELECT seq FROM events ORDER BY seq")).toEqual([{ seq: 2 }, { seq: 3 }]);
}, 15000);

it("fences before resolving committed or rolled-back transactions and can repeat after the fence-only crash window", async (test) => {
	const app = await store(test);
	await app.run({ op: "recover", epoch: "old" });
	await app.run({ op: "reserve", epoch: "old", transaction: "committed", count: 1 });
	await app.sql("INSERT INTO mutation_batches VALUES('committed',1,1,1)", "comms.db");
	await app.sql(`INSERT INTO outbox VALUES(1,'committed','${JSON.stringify(event(1))}',NULL)`, "comms.db");
	// Persist the first half of recovery, simulating death before boot resolution.
	await app.sql("UPDATE kernel_writer SET epoch='interrupted-fence'", "comms.db");
	expect(await app.run({ op: "recover", epoch: "replacement" })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT epoch FROM kernel_writer", "comms.db")).toEqual([{ epoch: "replacement" }]);
	expect(await app.run({ op: "query", since: 0 })).toMatchObject({ success: { items: [event(1)], cursor: 1 } });
	await app.run({ op: "reserve", epoch: "replacement", transaction: "rolled-back", count: 1 });
	expect(await app.run({ op: "recover", epoch: "next" })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT state FROM event_batches WHERE id='rolled-back'")).toEqual([{ state: "aborted" }]);
	expect(await app.run({ op: "reserve", epoch: "next", transaction: "after" })).toMatchObject({
		success: { from: 3, to: 3 },
	});
}, 15000);

it("commits the writer fence on inconsistent evidence, blocks publication, and refuses a missing initialized store", async (test) => {
	const app = await store(test);
	await app.run({ op: "recover", epoch: "old" });
	await app.run({ op: "reserve", epoch: "old", transaction: "bad", count: 1 });
	await app.sql("INSERT INTO mutation_batches VALUES('bad',1,1,1)", "comms.db");
	await app.sql(`INSERT INTO outbox VALUES(1,'wrong-tx','${JSON.stringify(event(1))}',NULL)`, "comms.db");
	expect(await app.run({ op: "recover", epoch: "fenced" })).toMatchObject({
		_tag: "Failure",
		failure: { code: "app_evidence_invalid" },
	});
	expect(await app.sql("SELECT epoch FROM kernel_writer", "comms.db")).toEqual([{ epoch: "fenced" }]);
	expect(await app.run({ op: "state" })).toMatchObject({ success: { pending_id: "bad", published_through: 0 } });
	await rm(join(app.root, "comms.db"));
	expect(await app.run({ op: "recover", epoch: "missing" })).toMatchObject({
		_tag: "Failure",
		failure: { code: "app_store_missing" },
	});
}, 15000);

it("migrates v5 without disturbing durable source journal and auth state", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	await app.sql("DROP TABLE seq");
	await app.sql("DROP TABLE events");
	await app.sql("DROP TABLE event_batches");
	await app.sql("DROP TABLE enrollments");
	await app.sql("DROP TABLE tokens");
	await app.sql("DROP TABLE mint_receipts");
	await app.sql("DROP TABLE refresh_receipts");
	await app.sql("DROP TABLE refresh_idempotency");
	for (const table of ["child_attempts", "backups", "cutover"]) await app.sql(`DROP TABLE ${table}`);
	await app.sql("ALTER TABLE sessions DROP COLUMN last_seen_at");
	await app.sql("PRAGMA user_version=5");
	await app.sql("INSERT INTO settings VALUES('preserved','value')");
	await app.sql("INSERT INTO source_batches VALUES('pending','lock','rahul',1,'publishing')");
	await app.sql("INSERT INTO source_changes VALUES('pending','app/x.ts',X'6162','before',493,X'6364','after',420)");
	await app.sql("INSERT INTO staging VALUES('lock','app/x.ts',X'6566','stage',2,493)");
	await app.sql("INSERT INTO sessions(id,hash,created_at,expires_at) VALUES('session','hash',1,9999999999999)");
	const before = await app.sql(
		"SELECT batch,path,hex(before) AS before_bytes,before_mode,hex(desired) AS desired_bytes,desired_mode FROM source_changes",
	);
	expect(await app.run({ op: "init" })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("PRAGMA user_version")).toEqual([{ user_version: 12 }]);
	expect(await app.sql("SELECT value FROM settings WHERE key='preserved'")).toEqual([{ value: "value" }]);
	expect(
		await app.sql(
			"SELECT batch,path,hex(before) AS before_bytes,before_mode,hex(desired) AS desired_bytes,desired_mode FROM source_changes",
		),
	).toEqual(before);
	expect(await app.sql("SELECT state FROM source_batches")).toEqual([{ state: "publishing" }]);
	expect(await app.sql("SELECT hex(content) AS content,mode FROM staging")).toEqual([{ content: "6566", mode: 493 }]);
	expect(await app.sql("SELECT * FROM sessions")).toEqual([
		{ id: "session", hash: "hash", created_at: 1, expires_at: 9999999999999, last_seen_at: null },
	]);
}, 15000);
