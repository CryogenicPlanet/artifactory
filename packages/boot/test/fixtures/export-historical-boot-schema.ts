// Run only after copying this file into the documented historical checkout.
import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";

const filename = process.argv[2];
const expectedVersion = Number(process.argv[3]);
assert.ok(filename && (expectedVersion === 16 || expectedVersion === 18));
const main = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	const version = yield* sql`PRAGMA user_version`;
	assert.equal(
		version[0]?.user_version,
		expectedVersion,
		"Use the exact historical checkout, never today's initializer",
	);
	const catalog = yield* sql`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`;
	const columns: Record<string, unknown> = {};
	const rows: Record<string, unknown> = {};
	for (const table of catalog) {
		if (table.type !== "table" || typeof table.name !== "string" || table.name.startsWith("sqlite_")) continue;
		columns[table.name] = yield* sql`SELECT * FROM pragma_table_xinfo(${table.name}) ORDER BY cid`;
		rows[table.name] = yield* sql`SELECT * FROM ${sql(table.name)}`;
	}
	const sqlite = yield* sql`SELECT sqlite_version() AS version`;
	yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
	return { bun: process.versions.bun, sqlite: sqlite[0]?.version, version: expectedVersion, catalog, columns, rows };
}).pipe(
	Effect.provide(SqliteClient.layer({ filename, disableWAL: true })),
	Effect.scoped,
	Effect.provide(BunServices.layer),
	Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))),
	Effect.flatMap(Console.log),
);
main.pipe(BunRuntime.runMain);
