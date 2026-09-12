import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Database } from "bun:sqlite";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";

const filename = process.argv[2];
const mode = process.argv[3];
const version = Number(process.argv[4]);
assert.ok(filename && mode && (version === 16 || version === 18));
const catalogQuery = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name";
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const directory = path.join(import.meta.dirname, "boot-schema-history");
	if (mode === "seed" || mode === "missing-column" || mode === "missing-table") {
		const ddl = yield* fs.readFileString(path.join(directory, `v${version}.sql`));
		const retained = yield* fs.readFileString(path.join(directory, "retained.sql"));
		const expected = yield* fs.readFileString(path.join(directory, `v${version}.catalog.json`));
		const db = new Database(filename);
		try {
			db.exec(ddl);
			assert.deepEqual(
				db.query(catalogQuery).all(),
				Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(expected),
			);
			db.exec(retained);
			if (mode === "missing-column") db.exec("ALTER TABLE sessions DROP COLUMN last_seen_at");
			if (mode === "missing-table") db.exec("DROP TABLE passkeys");
		} finally {
			db.close();
		}
		return "Historical artifact reconstructed without executing the current initializer";
	}
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const catalog = sql`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`;
			const before = yield* catalog;
			const settings = yield* sql`SELECT * FROM settings`;
			const event = yield* sql`SELECT seq,transaction_id,event,topic FROM events`;
			const restored = yield* sql`SELECT * FROM db_restore_requests`;
			const result = yield* initializeBootSchema.pipe(Effect.result);
			if (mode === "refuse") {
				assert.equal(result._tag, "Failure", "Post-adoption shape failure must refuse the actual initializer");
				assert.deepEqual(yield* catalog, before);
				assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: version }]);
				assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE name='boot_migrations'`, []);
			} else {
				if (result._tag === "Failure") return yield* result.failure;
				const historical18 = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
					yield* fs.readFileString(path.join(directory, "v18.catalog.json")),
				);
				const current = (yield* catalog).filter((row) => row.tbl_name !== "boot_migrations");
				assert.deepEqual(current, historical18, "Only the migration ledger may change the historical v18 catalog");
				const receipts = yield* sql`SELECT migration_id FROM boot_migrations ORDER BY migration_id`;
				assert.deepEqual(
					receipts.map((row) => row.migration_id),
					Array.from({ length: 20 }, (_, n) => n + 1),
				);
				assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 20 }]);
				assert.deepEqual(yield* sql`SELECT id,legacy_store_id,engine FROM backups`, [
					{ id: "historical-backup", legacy_store_id: null, engine: "sqlite" },
				]);
				assert.deepEqual(yield* sql`SELECT id,public_key,counter FROM passkeys`, [
					{ id: "historical-key", public_key: "fixture-public-key", counter: 7 },
				]);
				assert.deepEqual(yield* sql`SELECT id,hash,last_seen_at FROM sessions`, [
					{ id: "session", hash: "fixture-credential-hash", last_seen_at: 456 },
				]);
				assert.deepEqual(yield* sql`SELECT phase,candidate_epoch FROM cutover`, [
					{ phase: "accepted", candidate_epoch: "retained-epoch" },
				]);
				assert.deepEqual(yield* sql`SELECT next,published_through FROM seq`, [{ next: 43, published_through: 42 }]);
			}
			assert.deepEqual(yield* sql`SELECT * FROM settings`, settings);
			assert.deepEqual(yield* sql`SELECT seq,transaction_id,event,topic FROM events`, event);
			assert.deepEqual(yield* sql`SELECT * FROM db_restore_requests`, restored);
			yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
			return mode === "refuse"
				? "Refused without receipts, catalog, version or retained data changes"
				: "Historical adoption and retained data verified";
		}).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true }))),
	);
}).pipe(Effect.provide(BunServices.layer), Effect.flatMap(Console.log));
main.pipe(BunRuntime.runMain);
