import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Path } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeTransferApp, TransferAppInitializationError } from "../../src/kernel/transfer-app-initialize.ts";

const program = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const source = yield* fs.realPath(path.resolve(import.meta.dirname, "../../src"));
	const epoch = "a".repeat(64);
	for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
		const invalid = yield* initializeTransferApp(sql, epoch + suffix, source).pipe(Effect.result);
		assert.equal(invalid._tag, "Failure");
		assert.ok(invalid._tag === "Failure" && invalid.failure instanceof TransferAppInitializationError);
		assert.equal(invalid.failure.code, "transfer_epoch_invalid");
		assert.deepEqual(yield* sql`SELECT name FROM sqlite_schema`, []);
		assert.deepEqual(yield* sql`SELECT total_changes() AS changes`, [{ changes: 0 }]);
	}
	yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT NOT NULL)`;
	yield* sql`INSERT INTO kernel_writer VALUES(1,${epoch})`;
	yield* sql`CREATE TABLE mutation_batches(id TEXT PRIMARY KEY,from_seq INTEGER NOT NULL,to_seq INTEGER NOT NULL,count INTEGER NOT NULL)`;
	yield* sql`CREATE TABLE outbox(seq INTEGER PRIMARY KEY,transaction_id TEXT NOT NULL,event TEXT NOT NULL,shipped_at INTEGER)`;
	yield* sql`CREATE TABLE store_identity(singleton INTEGER PRIMARY KEY,store_id TEXT NOT NULL,initialized_at INTEGER NOT NULL,transferred_to TEXT)`;
	yield* sql`INSERT INTO store_identity VALUES(1,'aabbccdd-1234-4567-89ab-0123456789ab',1,NULL)`;
	const wrongSource = yield* initializeTransferApp(sql, epoch, path.dirname(source)).pipe(Effect.result);
	assert.equal(wrongSource._tag, "Failure");
	assert.equal((yield* sql`SELECT name FROM sqlite_schema WHERE name='messages'`).length, 0);
	const stale = yield* initializeTransferApp(sql, "b".repeat(64), source).pipe(Effect.result);
	assert.equal(stale._tag, "Failure");
	const result = yield* initializeTransferApp(sql, epoch, source);
	assert.equal(result.core.at(-1)?.migration_id, 11);
	assert.ok(result.extensions.length > 0);
	assert.deepEqual(
		result.extensionProofs.map(({ extension, name, targetChecksum }) => ({
			extension,
			name,
			checksum: targetChecksum,
		})),
		result.extensions,
	);
	const portable = yield* initializeTransferApp(sql, epoch, source, "pg");
	assert.deepEqual(portable.extensions, result.extensions);
	assert.equal(
		portable.extensionProofs.find((row) => row.name === "system_cursor")?.sourceChecksum,
		createHash("sha256")
			.update("CREATE TABLE IF NOT EXISTS system_cursor (id INTEGER PRIMARY KEY, seq BIGINT NOT NULL)")
			.digest("hex"),
	);
	assert.deepEqual(yield* initializeTransferApp(sql, epoch, source), result);
	assert.equal((yield* sql`SELECT * FROM messages`).length, 0);
	assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
	assert.deepEqual(yield* sql`SELECT store_id,initialized_at,transferred_to FROM store_identity`, [
		{ store_id: "aabbccdd-1234-4567-89ab-0123456789ab", initialized_at: 1, transferred_to: null },
	]);
	yield* Console.log("TRANSFER_APP_SCHEMA_VERIFIED");
}).pipe(Effect.scoped, Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
