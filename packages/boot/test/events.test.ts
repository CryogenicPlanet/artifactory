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
	expect(await app.run({ op: "append", batch })).toMatchObject({ success: { published_through: 4 } });
	expect(await app.run({ op: "query", since: 0, limit: 1 })).toMatchObject({
		success: { items: [event(1)], cursor: 1 },
	});
	expect(await app.run({ op: "query", since: 1 })).toMatchObject({
		success: { items: [event(2), { seq: 3, type: "seq.reserved" }, { seq: 4, type: "generation.live" }], cursor: 4 },
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
	expect(await app.sql("SELECT seq FROM events ORDER BY seq")).toEqual([{ seq: 2 }, { seq: 3 }, { seq: 4 }]);
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
	expect(await app.run({ op: "query", since: 0 })).toMatchObject({
		success: { items: [event(1), { seq: 2, type: "seq.reserved" }], cursor: 2 },
	});
	await app.run({ op: "reserve", epoch: "replacement", transaction: "rolled-back", count: 1 });
	expect(await app.run({ op: "recover", epoch: "next" })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT state FROM event_batches WHERE id='rolled-back'")).toEqual([{ state: "aborted" }]);
	expect(await app.run({ op: "reserve", epoch: "next", transaction: "after" })).toMatchObject({
		success: { from: 5, to: 5 },
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
	await app.sql("DROP TABLE IF EXISTS topic_moves");
	await app.sql("DROP TABLE IF EXISTS topic_page_moves");
	await app.sql("DROP TABLE db_restore_requests");
	await app.sql("ALTER TABLE generations DROP COLUMN backup_id");
	await app.sql("ALTER TABLE edit_lock DROP COLUMN reset_pin");
	for (const column of ["before_directory", "desired_directory"])
		await app.sql(`ALTER TABLE source_changes DROP COLUMN ${column}`);
	for (const column of ["previous_directory", "directory"]) await app.sql(`ALTER TABLE versions DROP COLUMN ${column}`);
	await app.sql("DROP TABLE enrollments");
	await app.sql("DROP TABLE tokens");
	await app.sql("DROP TABLE mint_receipts");
	await app.sql("DROP TABLE refresh_receipts");
	await app.sql("DROP TABLE refresh_idempotency");
	for (const table of ["child_attempts", "backups", "cutover"]) await app.sql(`DROP TABLE ${table}`);
	await app.sql("ALTER TABLE sessions DROP COLUMN last_seen_at");
	await app.sql("DROP TABLE public_paths");
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
	expect(await app.sql("PRAGMA user_version")).toEqual([{ user_version: 19 }]);
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

it("routes moved history without changing immutable replay identity or rerouting recreated paths", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	const original = {
		transaction: "original",
		from: 1,
		to: 2,
		events: [
			{ ...event(1), topic: "a/child", payload: { topic: "a/child", body: "old" } },
			{ ...event(2), topic: "ab/child" },
		],
	};
	await app.run({ op: "reserve", transaction: "original", count: 2 });
	await app.run({ op: "append", batch: original });
	const rawBefore = await app.sql("SELECT event FROM events WHERE seq<=2 ORDER BY seq");
	const move = {
		transaction: "move-one",
		from: 4,
		to: 4,
		events: [{ ...event(4), type: "topic.moved", topic: "b", payload: { from: "a", to: "b" } }],
	};
	await app.run({ op: "reserve", transaction: "move-one" });
	expect(await app.run({ op: "append", batch: move })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT event FROM events WHERE seq<=2 ORDER BY seq")).toEqual(rawBefore);
	expect(await app.run({ op: "query", topic: "b", since: 0, limit: 1 })).toMatchObject({
		success: {
			items: [{ seq: 1, topic: "b/child", payload: { topic: "a/child", body: "old" } }],
			cursor: 1,
		},
	});
	expect(await app.run({ op: "query", topic: "a", since: 0 })).toMatchObject({ success: { items: [] } });
	expect(await app.run({ op: "query", topic: "ab", since: 0 })).toMatchObject({
		success: { items: [{ seq: 2, topic: "ab/child" }] },
	});
	expect(await app.run({ op: "append", epoch: "restart", batch: original })).toMatchObject({ _tag: "Success" });
	expect(
		await app.run({
			op: "append",
			epoch: "restart",
			batch: {
				...original,
				events: original.events.map((item) => (item.seq === 1 ? { ...item, topic: "b/child" } : item)),
			},
		}),
	).toMatchObject({ _tag: "Failure", failure: { code: "batch_conflict" } });
	// A newly created topic at the old path is not the subtree that the old receipt moved.
	await app.run({ op: "boot", event: { ...event(6), topic: "a/new" } });
	const next = {
		transaction: "move-two",
		from: 7,
		to: 7,
		events: [{ ...event(7), type: "topic.moved", topic: "c", payload: { from: "b", to: "c" } }],
	};
	await app.run({ op: "reserve", transaction: "move-two" });
	await app.run({ op: "append", batch: next });
	expect(await app.run({ op: "append", epoch: "restart", batch: move })).toMatchObject({ _tag: "Success" });
	expect(await app.run({ op: "query", topic: "a", since: 0 })).toMatchObject({
		success: { items: [{ seq: 6, topic: "a/new" }] },
	});
	expect(await app.run({ op: "query", topic: "c", since: 0 })).toMatchObject({
		success: {
			items: [
				{ seq: 1, topic: "c/child" },
				{ seq: 4, topic: "c" },
				{ seq: 7, topic: "c" },
			],
		},
	});
	await app.sql("DELETE FROM events WHERE seq IN (1,4)");
	await app.run({ op: "append", epoch: "again", batch: original });
	await app.run({ op: "append", epoch: "again", batch: move });
	expect(await app.sql("SELECT seq,topic FROM events ORDER BY seq")).toEqual([
		{ seq: 2, topic: "ab/child" },
		{ seq: 3, topic: null },
		{ seq: 5, topic: null },
		{ seq: 6, topic: "a/new" },
		{ seq: 7, topic: "c" },
		{ seq: 8, topic: null },
	]);
}, 15000);

it("rejects malformed moves and rolls routing back with publication failures", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	await app.run({ op: "boot", event: { ...event(1), topic: "a/child" } });
	await app.run({ op: "reserve", transaction: "move" });
	const batch = {
		transaction: "move",
		from: 2,
		to: 2,
		events: [{ ...event(2), type: "topic.moved", topic: "b", payload: { from: "a", to: "b" } }],
	};
	const append = (from: string, to: string) =>
		app.run({ op: "append", batch: { ...batch, events: [{ ...batch.events[0], payload: { from, to } }] } });
	for (const [from, to] of [
		["", "b"],
		["a", "a"],
		["a", "a/child"],
		["a/child", "a"],
		["a/../b", "c"],
		["a", "B"],
		["a", "x".repeat(201)],
	]) {
		expect(await append(from ?? "", to ?? "")).toMatchObject({
			_tag: "Failure",
			failure: { code: "topic_move_invalid" },
		});
	}
	await app.sql(
		"CREATE TRIGGER fail_move BEFORE INSERT ON events WHEN NEW.seq=2 BEGIN SELECT RAISE(ABORT,'injected'); END",
	);
	expect(await app.run({ op: "append", batch })).toMatchObject({ _tag: "Failure" });
	expect(await app.sql("SELECT topic FROM events ORDER BY seq")).toEqual([{ topic: "a/child" }, { topic: null }]);
	expect(await app.run({ op: "state" })).toMatchObject({ success: { published_through: 1, pending_id: "move" } });
	await app.sql("DROP TRIGGER fail_move");
	expect(await app.run({ op: "append", batch })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT topic FROM events ORDER BY seq")).toEqual([
		{ topic: "b/child" },
		{ topic: "b" },
		{ topic: null },
	]);
	expect(await app.run({ op: "boot", event: batch.events[0] })).toMatchObject({
		_tag: "Failure",
		failure: { code: "topic_move_unprepared" },
	});
}, 15000);

it("backfills legacy routing without altering pending state or original event bytes", async (test) => {
	const app = await store(test);
	await app.run({ op: "boot", event: event(1) });
	await app.run({ op: "reserve", transaction: "pending" });
	const before = await app.sql("SELECT event FROM events");
	const pending = await app.sql("SELECT * FROM seq");
	for (const column of ["type", "actor", "instance", "level", "topic"]) {
		await app.sql(`DROP INDEX events_${column}_seq`);
		await app.sql(`ALTER TABLE events DROP COLUMN ${column}`);
	}
	await app.sql("DROP TABLE IF EXISTS topic_moves");
	await app.sql("DROP TABLE IF EXISTS topic_page_moves");
	await app.sql("DROP TABLE db_restore_requests");
	await app.sql("ALTER TABLE generations DROP COLUMN backup_id");
	await app.sql("ALTER TABLE edit_lock DROP COLUMN reset_pin");
	for (const column of ["before_directory", "desired_directory"])
		await app.sql(`ALTER TABLE source_changes DROP COLUMN ${column}`);
	for (const column of ["previous_directory", "directory"]) await app.sql(`ALTER TABLE versions DROP COLUMN ${column}`);
	await app.sql("DROP TABLE public_paths");
	await app.sql("ALTER TABLE backups DROP COLUMN legacy_store_id");
	await app.sql("ALTER TABLE backups DROP COLUMN engine");
	await app.sql("PRAGMA user_version=12");
	expect(await app.run({ op: "init" })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT topic FROM events ORDER BY seq")).toEqual([
		{ topic: "project/thread" },
		{ topic: null },
	]);
	expect(await app.sql("SELECT event FROM events")).toEqual(before);
	expect(await app.sql("SELECT * FROM seq")).toEqual(pending);
	expect(await app.run({ op: "query", topic: "project", since: 0 })).toMatchObject({ success: { items: [event(1)] } });
});

it("migrates indexed projections without changing routed topics, JSON bytes or pending publication", async (test) => {
	const app = await store(test);
	await app.run({ op: "boot", event: { ...event(1), instance: null } });
	await app.sql("UPDATE events SET topic='moved/thread'");
	await app.run({ op: "reserve", transaction: "pending" });
	const before = await app.sql("SELECT seq,transaction_id,event,topic FROM events");
	const pending = await app.sql("SELECT * FROM seq");
	for (const column of ["type", "actor", "instance", "level", "topic"])
		await app.sql(`DROP INDEX events_${column}_seq`);
	for (const column of ["type", "actor", "instance", "level"])
		await app.sql(`ALTER TABLE events DROP COLUMN ${column}`);
	await app.sql("DROP TABLE public_paths");
	await app.sql("ALTER TABLE generations DROP COLUMN backup_id");
	await app.sql("ALTER TABLE edit_lock DROP COLUMN reset_pin");
	for (const column of ["source_generation", "prior_generation", "source_batch"])
		await app.sql(`ALTER TABLE db_restore_requests DROP COLUMN ${column}`);
	await app.sql("ALTER TABLE backups DROP COLUMN legacy_store_id");
	await app.sql("ALTER TABLE backups DROP COLUMN engine");
	await app.sql("PRAGMA user_version=13");
	expect(await app.run({ op: "init" })).toMatchObject({ _tag: "Success" });
	expect(await app.run({ op: "init" })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT seq,transaction_id,event,topic FROM events")).toEqual(before);
	expect(await app.sql("SELECT * FROM seq")).toEqual(pending);
	expect(await app.sql("SELECT type,actor,instance,level,topic FROM events ORDER BY seq")).toEqual([
		{ type: "message.created", actor: "rahul", instance: null, level: "info", topic: "moved/thread" },
		{ type: "seq.reserved", actor: "boot", instance: null, level: "info", topic: null },
	]);
	expect(
		await app.run({ op: "query", since: 0, topic: "moved", types: ["message.*"], agent: "rahul", level: "info" }),
	).toMatchObject({ success: { items: [{ ...event(1), instance: null, topic: "moved/thread" }], cursor: 1 } });
}, 15000);

it("publishes an app-owned move with long historical routing and recovers without a boot intent", async (test) => {
	const app = await store(test);
	await app.run({ op: "recover", epoch: "old" });
	await app.run({ op: "boot", event: { ...event(1), topic: "a/" + "z".repeat(198) } });
	const destination = "b".repeat(200);
	await app.run({ op: "reserve", epoch: "old", transaction: "app-move" });
	const moved = { ...event(2), type: "topic.moved", topic: destination, payload: { from: "a", to: destination } };
	await app.sql("INSERT INTO mutation_batches VALUES('app-move',2,2,1)", "comms.db");
	await app.sql(`INSERT INTO outbox VALUES(2,'app-move','${JSON.stringify(moved)}',NULL)`, "comms.db");
	expect(await app.run({ op: "recover", epoch: "next" })).toMatchObject({ _tag: "Success" });
	expect(await app.run({ op: "query", since: 0, topic: destination })).toMatchObject({
		success: {
			items: [
				{ seq: 1, topic: destination + "/" + "z".repeat(198) },
				{ seq: 2, topic: destination },
			],
			cursor: 3,
		},
	});
	expect(
		await app.sql("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('topic_moves','topic_page_moves')"),
	).toEqual([]);
}, 15000);

it("boot diagnostics expose recovery failures behind a stuck app fence without exposing app events", async (test) => {
	const app = await store(test);
	await app.run({ op: "boot", event: { ...event(0), type: "generation.live" } });
	await app.run({ op: "reserve", transaction: "spoof", count: 1 });
	await app.run({ op: "boot", event: { ...event(0), type: "generation.failed" } });
	await app.sql(
		"INSERT INTO generations(n,entry_file,status,started_at,error,stderr) VALUES(1,'server.ts','failed',1,'startup failure','private-startup-marker')",
	);
	expect(await app.run({ op: "diagnostics" })).toMatchObject({
		success: {
			items: [{ seq: 1 }, { seq: 4, current_failure: { error: "startup failure", stderr: "private-startup-marker" } }],
			cursor: 4,
		},
	});
	expect(await app.run({ op: "query", since: 0 })).toMatchObject({ success: { items: [{ seq: 1 }], cursor: 1 } });
	expect(await app.sql("SELECT pending_id,published_through FROM seq")).toEqual([
		{ pending_id: "spoof", published_through: 1 },
	]);
	await app.run({
		op: "append",
		batch: {
			transaction: "spoof",
			from: 2,
			to: 2,
			events: [{ ...event(2), type: "generation.failed", actor: "boot" }],
		},
	});
	await app.run({ op: "boot", event: { ...event(0), type: "http.request" } });
	expect(await app.run({ op: "diagnostics", limit: 1 })).toMatchObject({ success: { items: [{ seq: 5 }], cursor: 5 } });
	expect(await app.run({ op: "diagnostics", since: 0, limit: 1 })).toMatchObject({
		success: { items: [{ seq: 1 }], cursor: 1 },
	});
	expect(await app.run({ op: "diagnostics", since: 1, limit: 1 })).toMatchObject({
		success: { items: [{ seq: 4 }], cursor: 4 },
	});
	expect(await app.run({ op: "diagnostics", since: 6 })).toMatchObject({ failure: { code: "cursor_ahead" } });
	expect(await app.sql("SELECT count(*) AS n FROM events")).toEqual([{ n: 5 }]);
	expect(JSON.stringify(await app.run({ op: "query", since: 0 }))).not.toContain("private-startup-marker");
});
