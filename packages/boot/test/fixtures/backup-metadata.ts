import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { BackupRecord } from "../../src/backup-metadata.ts";

const main = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	if (process.argv[3] === "v17") {
		yield* sql`DROP TABLE auth_origins`;
		yield* sql`DROP TABLE passkey_codes`;
		yield* sql`ALTER TABLE passkeys DROP COLUMN rp_id`;
		yield* sql`ALTER TABLE sessions DROP COLUMN origin`;
		yield* sql`ALTER TABLE backups DROP COLUMN engine`;
		yield* sql`DROP TABLE boot_migrations`;
		yield* sql`PRAGMA user_version=17`;
		yield* sql`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through,generation,legacy_store_id)
			VALUES('retained','/retained/exact.db','pre-flip',4096,123,42,7,'adopted-store')`;
		const before = yield* sql`SELECT * FROM backups`;
		yield* initializeBootSchema;
		assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 20 }]);
		const migrated = yield* sql`SELECT * FROM backups`;
		assert.deepEqual(
			migrated,
			before.map((row) => ({ ...row, engine: "sqlite" })),
		);
		yield* initializeBootSchema;
		assert.deepEqual(yield* sql`SELECT * FROM backups`, migrated);
		assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 20 }]);
		return yield* Console.log("v17 backup provenance preserved");
	}
	yield* sql`ALTER TABLE child_attempts DROP COLUMN boot_id`;
	yield* sql`ALTER TABLE backups DROP COLUMN published_through`;
	yield* sql`ALTER TABLE backups DROP COLUMN generation`;
	yield* sql`DROP TABLE public_paths`;
	yield* sql`DROP INDEX events_type_seq`;
	yield* sql`DROP INDEX events_actor_seq`;
	yield* sql`DROP INDEX events_instance_seq`;
	yield* sql`DROP INDEX events_level_seq`;
	yield* sql`DROP INDEX events_topic_seq`;
	yield* sql`ALTER TABLE events DROP COLUMN type`;
	yield* sql`ALTER TABLE events DROP COLUMN actor`;
	yield* sql`ALTER TABLE events DROP COLUMN instance`;
	yield* sql`ALTER TABLE events DROP COLUMN level`;
	yield* sql`ALTER TABLE events DROP COLUMN topic`;
	yield* sql`DROP TABLE IF EXISTS topic_moves`;
	yield* sql`DROP TABLE IF EXISTS topic_page_moves`;
	yield* sql`DROP TABLE db_restore_requests`;
	yield* sql`ALTER TABLE generations DROP COLUMN backup_id`;
	yield* sql`ALTER TABLE source_changes DROP COLUMN before_directory`;
	yield* sql`ALTER TABLE source_changes DROP COLUMN desired_directory`;
	yield* sql`ALTER TABLE versions DROP COLUMN previous_directory`;
	yield* sql`ALTER TABLE versions DROP COLUMN directory`;
	yield* sql`ALTER TABLE edit_lock DROP COLUMN reset_pin`;
	yield* sql`ALTER TABLE backups DROP COLUMN legacy_store_id`;
	yield* sql`DROP TABLE auth_origins`;
	yield* sql`DROP TABLE passkey_codes`;
	yield* sql`ALTER TABLE passkeys DROP COLUMN rp_id`;
	yield* sql`ALTER TABLE sessions DROP COLUMN origin`;
	yield* sql`DROP TABLE IF EXISTS boot_migrations`;
	yield* sql`ALTER TABLE backups DROP COLUMN engine`;
	yield* sql`PRAGMA user_version=11`;
	yield* sql`INSERT INTO backups VALUES('legacy','/retained/legacy.db','pre-flip',1234,99)`;
	yield* initializeBootSchema;
	yield* initializeBootSchema;
	const rows = yield* sql`SELECT * FROM backups`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BackupRecord))),
	);
	assert.deepEqual(rows, [
		{
			id: "legacy",
			path: "/retained/legacy.db",
			reason: "pre-flip",
			bytes: 1234,
			taken_at: 99,
			published_through: null,
			generation: null,
			legacy_store_id: null,
			engine: "sqlite",
		},
	]);
	assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 20 }]);
	yield* Console.log("backup metadata preserved");
}).pipe(
	Effect.scoped,
	Effect.provide(
		SqliteClient.layer({ filename: process.argv[2] ?? ":memory:", disableWAL: true }).pipe(
			Layer.provideMerge(BunServices.layer),
		),
	),
);
main.pipe(BunRuntime.runMain);
