import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { clientLayer } from "@comms/storage/client";
import { Console, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";

const filename = process.argv[2];
if (!filename) throw Error("Missing database filename");
const mode = process.argv[3];
const main = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const names = [
		"generations",
		"settings",
		"edit_lock",
		"authentication",
		"source_history",
		"events",
		"enrollment",
		"refresh",
		"cutover",
		"session_activity",
		"mint_receipts",
		"backup_metadata",
		"recovery_journals",
		"event_filters",
		"combined_restore",
		"reset_pin",
		"store_identity",
		"backup_engine",
	];
	const receipts = sql`SELECT migration_id,name FROM boot_migrations ORDER BY migration_id`;
	const snapshot = Effect.gen(function* () {
		return {
			schema: yield* sql`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`,
			version: yield* sql`PRAGMA user_version`,
			receipts: yield* receipts,
			settings: yield* sql`SELECT * FROM settings ORDER BY key`,
			sessions: yield* sql`SELECT * FROM sessions ORDER BY id`,
		};
	});
	if (mode === "legacy") {
		yield* initializeBootSchema;
		yield* sql`INSERT INTO settings VALUES('retained','not JSON: unchanged')`;
		yield* sql`INSERT INTO sessions(id,hash,created_at,expires_at,last_seen_at) VALUES('session','credential',123,9000000000000,456)`;
		yield* sql`DROP TABLE boot_migrations`;
		assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 18 }]);
		return yield* Console.log("legacy fixture persisted");
	}
	if (mode === "fresh" || mode === "adopt") {
		yield* initializeBootSchema;
		assert.deepEqual(
			yield* receipts,
			names.map((name, index) => ({ migration_id: index + 1, name })),
		);
		assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 18 }]);
		if (mode === "adopt") {
			assert.deepEqual(yield* sql`SELECT * FROM settings WHERE key='retained'`, [
				{ key: "retained", value: "not JSON: unchanged" },
			]);
			assert.deepEqual(yield* sql`SELECT * FROM sessions`, [
				{ id: "session", hash: "credential", created_at: 123, expires_at: 9000000000000, last_seen_at: 456 },
			]);
		}
		return yield* Console.log(JSON.stringify(yield* snapshot));
	}
	yield* initializeBootSchema;
	if (mode === "empty") yield* sql`DELETE FROM boot_migrations`;
	else if (mode === "gap") yield* sql`DELETE FROM boot_migrations WHERE migration_id=9`;
	else if (mode === "name") yield* sql`UPDATE boot_migrations SET name='wrong_name' WHERE migration_id=9`;
	else if (mode === "mirror") yield* sql`PRAGMA user_version=17`;
	else if (mode === "newer-ledger") yield* sql`INSERT INTO boot_migrations(migration_id,name) VALUES(19,'future')`;
	else if (mode === "newer-version") yield* sql`PRAGMA user_version=19`;
	else return yield* Effect.die("Unknown fixture mode");
	const before = yield* snapshot;
	const result = yield* initializeBootSchema.pipe(Effect.result);
	assert.equal(result._tag, "Failure");
	if (result._tag === "Failure") {
		const expected =
			mode === "newer-version"
				? "BootSchemaTooNew"
				: mode === "newer-ledger"
					? "migration_ledger_too_new"
					: "migration_ledger_invalid";
		assert.ok(JSON.stringify(result.failure).includes(expected), JSON.stringify(result.failure));
	}
	assert.deepEqual(yield* snapshot, before);
	yield* Console.log("refused without schema, receipt, mirror or data changes");
}).pipe(
	Effect.provide(clientLayer({ _tag: "file", filename }).pipe(Layer.provideMerge(BunServices.layer))),
	Effect.scoped,
);
main.pipe(BunRuntime.runMain);
