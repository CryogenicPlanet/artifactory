import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { inspectTransferSource, resolveTransferSource } from "../../../src/transfer/source-preflight.ts";
import { TransferRejected } from "@comms/storage/store-transfer-schema";

const main = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const fs = yield* FileSystem.FileSystem;
	const directory = yield* fs.makeTempDirectoryScoped();
	const filename = `${directory}/comms.db`;
	yield* fs.writeFileString(filename, "fixture");
	const id = "12345678-1234-4234-8234-123456789abc";
	const file = { _tag: "file", filename } as const;
	const remote = {
		_tag: "postgres",
		database: "environment",
		url: Redacted.make("postgres://app:secret@example.test/environment"),
	} as const;
	yield* sql`CREATE TABLE boot_migrations(migration_id INTEGER PRIMARY KEY,name TEXT)`;
	for (let n = 1; n <= 20; n++)
		yield* sql`INSERT INTO boot_migrations VALUES(${n},${n === 20 ? "offline_store_transfer" : `migration-${n}`})`;
	yield* sql`PRAGMA user_version=20`;
	yield* sql`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)`;
	const adoption = { store_id: id, initialized_at: 123, phase: "ready", filename, mode: "fresh" };
	const set = (key: string, value: string) =>
		sql`INSERT INTO settings VALUES(${key},${value}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
	yield* set("app_store_adoption", JSON.stringify(adoption));
	yield* set("app_store_id", id);
	yield* set("app_store_initialized", "1");
	yield* sql`CREATE TABLE store_identity(singleton INTEGER,store_id TEXT,initialized_at INTEGER,transferred_to TEXT)`;
	yield* sql`INSERT INTO store_identity VALUES(1,${id},123,NULL)`;
	yield* sql`CREATE TABLE kernel_writer(singleton INTEGER,epoch TEXT)`;
	yield* sql`INSERT INTO kernel_writer VALUES(1,'prior-epoch')`;
	yield* sql`CREATE TABLE seq(singleton INTEGER,next INTEGER,published_through INTEGER,pending_id TEXT,pending_attempt TEXT,pending_from INTEGER,pending_to INTEGER)`;
	yield* sql`INSERT INTO seq VALUES(1,8,7,NULL,NULL,NULL,NULL)`;
	for (const ddl of [
		"CREATE TABLE cutover(singleton INTEGER)",
		"CREATE TABLE db_restore_requests(phase TEXT,lock_id TEXT)",
		"CREATE TABLE source_batches(state TEXT)",
		"CREATE TABLE source_changes(batch TEXT)",
		"CREATE TABLE edit_lock(id TEXT)",
		"CREATE TABLE staging(path TEXT)",
		"CREATE TABLE child_attempts(closed INTEGER)",
		"CREATE TABLE event_batches(state TEXT)",
		"CREATE TABLE outbox(seq INTEGER,shipped_at INTEGER)",
		"CREATE TABLE topic_page_continuations(completed INTEGER)",
		"CREATE TABLE generations(n INTEGER,entry_file TEXT,snapshot_dir TEXT,good INTEGER)",
	])
		yield* sql.unsafe(ddl);
	yield* sql`INSERT INTO generations VALUES(3,'server.ts','/data/snapshots/3',1),(4,'broken.ts',NULL,0)`;
	assert.deepEqual(yield* resolveTransferSource({ app: file }, sql), file);
	assert.deepEqual(yield* inspectTransferSource(sql, sql, file), {
		store_id: id,
		initialized_at: 123,
		generation: { n: 3, entry_file: "server.ts", snapshot_dir: "/data/snapshots/3" },
	});
	const refuse = <A, E, R>(effect: Effect.Effect<A, E, R>, code: string) =>
		Effect.gen(function* () {
			const result = yield* effect.pipe(Effect.result);
			assert.equal(result._tag, "Failure");
			if (result._tag === "Failure") {
				assert.equal(Schema.is(TransferRejected)(result.failure), true);
				if (Schema.is(TransferRejected)(result.failure)) assert.equal(result.failure.code, code);
			}
		});
	const inspect = inspectTransferSource(sql, sql, file);
	yield* set(
		"app_store_schema",
		JSON.stringify({ store_id: id, initialized_at: 123, operations: ["one"], next: 0, active: "one" }),
	);
	yield* refuse(inspect, "transfer_recovery_pending");
	yield* sql`DELETE FROM settings WHERE key='app_store_schema'`;
	yield* sql`DELETE FROM kernel_writer`;
	yield* refuse(inspect, "transfer_recovery_pending");
	yield* sql`INSERT INTO kernel_writer VALUES(1,'prior-epoch')`;
	yield* set("source-revert:historical", "selector");
	yield* inspect;
	yield* set("source-revert-result:pending", JSON.stringify({ outcome: null }));
	yield* refuse(inspect, "transfer_recovery_pending");
	yield* sql`DELETE FROM settings WHERE key='source-revert-result:pending'`;

	for (const [insert, clear] of [
		["INSERT INTO cutover VALUES(1)", "DELETE FROM cutover"],
		["INSERT INTO db_restore_requests VALUES('working',NULL)", "DELETE FROM db_restore_requests"],
		["INSERT INTO source_batches VALUES('publishing')", "DELETE FROM source_batches"],
		["INSERT INTO source_changes VALUES('b')", "DELETE FROM source_changes"],
		["INSERT INTO edit_lock VALUES('l')", "DELETE FROM edit_lock"],
		["INSERT INTO staging VALUES('p')", "DELETE FROM staging"],
		["INSERT INTO child_attempts VALUES(0)", "DELETE FROM child_attempts"],
		["INSERT INTO event_batches VALUES('pending')", "DELETE FROM event_batches"],
		["INSERT INTO outbox VALUES(7,NULL)", "DELETE FROM outbox"],
		["INSERT INTO topic_page_continuations VALUES(0)", "DELETE FROM topic_page_continuations"],
	] as const) {
		yield* sql.unsafe(insert);
		yield* refuse(inspect, "transfer_recovery_pending");
		yield* sql.unsafe(clear);
	}
	yield* sql`UPDATE seq SET pending_attempt='orphan'`;
	yield* refuse(inspect, "transfer_recovery_pending");
	yield* sql`UPDATE seq SET pending_attempt=NULL`;
	yield* sql`UPDATE store_identity SET store_id='foreign'`;
	yield* refuse(inspect, "transfer_identity_mismatch");
	yield* sql`UPDATE store_identity SET store_id=${id}`;
	yield* set("app_store_adoption", JSON.stringify({ ...adoption, phase: "pending" }));
	yield* refuse(resolveTransferSource({ app: file }, sql), "transfer_identity_mismatch");
	yield* set(
		"app_store_adoption",
		JSON.stringify({ store_id: id, initialized_at: 123, phase: "ready", engine: "postgres", database: "selected" }),
	);
	yield* set("app_store_database", "selected");
	const selected = yield* resolveTransferSource({ app: remote }, sql);
	assert.equal(selected._tag, "postgres");
	if (selected._tag === "postgres") {
		assert.equal(selected.database, "selected");
		assert.equal(Redacted.value(selected.url), "postgres://app:secret@example.test/selected");
	}
	yield* set("transfer_state", "complete");
	yield* refuse(resolveTransferSource({ app: remote }, sql), "transfer_recovery_pending");
	let activated = false;
	yield* resolveTransferSource(
		{
			app: remote,
			assertActivated: Effect.sync(() => {
				activated = true;
			}),
		},
		sql,
	);
	assert.equal(activated, true);
	yield* set("transfer_state", "in_progress");
	yield* refuse(resolveTransferSource({ app: remote }, sql), "transfer_recovery_pending");
	yield* sql`DELETE FROM settings WHERE key='transfer_state'`;
	yield* set("transferred_to", "other transfer");
	yield* refuse(resolveTransferSource({ app: remote }, sql), "transfer_source_retired");
	yield* sql`DELETE FROM settings WHERE key='transferred_to'`;
	yield* set("app_store_adoption", JSON.stringify(adoption));
	yield* sql`DROP TABLE topic_page_continuations`;
	const missing = yield* inspect.pipe(Effect.result);
	assert.equal(missing._tag, "Failure");
	if (missing._tag === "Failure") assert.equal(Schema.is(TransferRejected)(missing.failure), false);
	yield* sql`DELETE FROM boot_migrations WHERE migration_id=20`;
	yield* refuse(resolveTransferSource({ app: remote }, sql), "transfer_protocol_unsupported");
	return { passed: true };
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(
	Effect.flatMap((value) => Console.log(JSON.stringify(value))),
	BunRuntime.runMain,
);
