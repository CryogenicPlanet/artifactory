import { on } from "@comms/storage/dialect";
import { tableShape, type ColumnShape } from "@comms/storage/remote-migrations";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export const protectionColumns = (mysql: boolean): ReadonlyArray<ColumnShape> => [
	{
		name: "name",
		type: mysql ? "varchar" : "character varying",
		length: 128,
		nullable: false,
		default: null,
		expression: mysql ? "" : null,
		...(mysql ? { collation: "utf8mb4_0900_bin" } : {}),
	},
	...[
		{ name: "extension", length: 255 },
		{ name: "migration", length: 128 },
	].map((column) => ({
		...column,
		type: mysql ? "varchar" : "character varying",
		nullable: true,
		default: null,
		expression: mysql ? "" : null,
		...(mysql ? { collation: "utf8mb4_0900_bin" } : {}),
	})),
];

/** No ownership inference: all pre-existing registrations retain NULL provenance. */
export const migrateProtectionOwnership = (sql: SqlClient.SqlClient) =>
	Effect.gen(function* () {
		yield* sql`CREATE TABLE IF NOT EXISTS protected_sql_tables(name TEXT PRIMARY KEY COLLATE NOCASE)`;
		yield* sql`ALTER TABLE protected_sql_tables ADD COLUMN extension TEXT`;
		yield* sql`ALTER TABLE protected_sql_tables ADD COLUMN migration TEXT`;
	});

export const protectionOwnershipOperation = (sql: SqlClient.SqlClient) => ({
	name: "protection_ownership",
	run: sql`ALTER TABLE protected_sql_tables ADD COLUMN extension VARCHAR(255), ADD COLUMN migration VARCHAR(128)`.pipe(
		Effect.asVoid,
	),
	postcondition: Effect.gen(function* () {
		const mysql = on(sql, { sqlite: () => false, pg: () => false, mysql: () => true });
		const rows = yield* (
			mysql
				? sql`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='protected_sql_tables' AND COLUMN_NAME IN ('extension','migration')`
				: sql`SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='protected_sql_tables' AND column_name IN ('extension','migration')`
		).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))));
		if (!rows.length) return false;
		return yield* tableShape(sql, "protected_sql_tables", protectionColumns(mysql), ["name"], {
			checks: [],
			foreignKeys: [],
		});
	}),
});
