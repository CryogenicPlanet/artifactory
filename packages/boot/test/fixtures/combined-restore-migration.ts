import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";

const main = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	yield* sql`ALTER TABLE generations DROP COLUMN backup_id`;
	for (const column of ["source_generation", "prior_generation", "source_batch"])
		yield* sql.unsafe(`ALTER TABLE db_restore_requests DROP COLUMN ${column}`);
	yield* sql`ALTER TABLE edit_lock DROP COLUMN reset_pin`;
	yield* sql`ALTER TABLE backups DROP COLUMN legacy_store_id`;
	yield* sql`ALTER TABLE backups DROP COLUMN engine`;
	yield* sql`PRAGMA user_version=14`;
	for (const n of [1, 2, 3, 4])
		yield* sql`INSERT INTO generations(n,entry_file,status,good,started_at) VALUES(${n},'server.ts','retired',1,1)`;
	for (const backup of [
		{ id: "unique", reason: "pre-flip", generation: 1 },
		{ id: "hourly-one", reason: "hourly", generation: 1 },
		{ id: "ambiguous-a", reason: "pre-flip", generation: 2 },
		{ id: "ambiguous-b", reason: "pre-flip", generation: 2 },
		{ id: "hourly-only", reason: "hourly", generation: 3 },
		{ id: "unknown", reason: "pre-flip", generation: null },
	])
		yield* sql`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through,generation)
			VALUES(${backup.id},${`/backups/${backup.id}.db`},${backup.reason},100,1,7,${backup.generation})`;
	yield* sql`INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,idempotency_key,backup,phase,generation,restored_to_seq,event_seq)
		VALUES('proof','hash','session','retry','unique','restored',3,7,8)`;
	const receipts =
		yield* sql`SELECT proof_id,proof_hash,session_id,idempotency_key,backup,phase,generation,restored_to_seq,event_seq FROM db_restore_requests`;
	const backups = yield* sql`SELECT * FROM backups ORDER BY id`;
	yield* initializeBootSchema;
	assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 19 }]);
	assert.deepEqual(yield* sql`SELECT n,backup_id FROM generations ORDER BY n`, [
		{ n: 1, backup_id: "unique" },
		{ n: 2, backup_id: null },
		{ n: 3, backup_id: null },
		{ n: 4, backup_id: null },
	]);
	assert.deepEqual(yield* sql`SELECT source_generation,prior_generation,source_batch FROM db_restore_requests`, [
		{ source_generation: null, prior_generation: 3, source_batch: null },
	]);
	assert.deepEqual(
		yield* sql`SELECT proof_id,proof_hash,session_id,idempotency_key,backup,phase,generation,restored_to_seq,event_seq FROM db_restore_requests`,
		receipts,
	);
	assert.deepEqual(
		yield* sql`SELECT * FROM backups ORDER BY id`,
		backups.map((row) => ({ ...row, legacy_store_id: null, engine: "sqlite" })),
	);
	// A later catalog change must not retroactively resolve an ambiguous migration or replace its exact association.
	yield* sql`DELETE FROM backups WHERE id IN ('ambiguous-b','unique')`;
	yield* initializeBootSchema;
	assert.deepEqual(yield* sql`SELECT n,backup_id FROM generations WHERE n IN (1,2) ORDER BY n`, [
		{ n: 1, backup_id: "unique" },
		{ n: 2, backup_id: null },
	]);
	yield* Console.log("combined restore migration passed");
}).pipe(
	Effect.scoped,
	Effect.provide(
		SqliteClient.layer({ filename: process.argv[2] ?? ":memory:", disableWAL: true }).pipe(
			Layer.provideMerge(BunServices.layer),
		),
	),
);
main.pipe(BunRuntime.runMain);
