import { on } from "@comms/storage/dialect";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";

export const kernelSqlTables = Object.freeze([
	"kernel_writer",
	"store_identity",
	"core_migrations",
	"migrations",
	"kernel_migration_intent",
	"mutation_batches",
	"outbox",
	"idempotency",
	"extension_migrations",
	"protected_sql_tables",
]);
export const validProtectedTableName = (name: string) => /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(name);
const initialize = (sql: SqlClient.SqlClient) =>
	on(sql, {
		sqlite: () =>
			sql`CREATE TABLE IF NOT EXISTS protected_sql_tables(name TEXT PRIMARY KEY COLLATE NOCASE,extension TEXT,migration TEXT)`.pipe(
				Effect.asVoid,
			),
		// Remote schema setup creates this before writer transactions; MySQL DDL implicitly commits.
		pg: () => Effect.void,
		mysql: () => Effect.void,
	});

/** Called inside an epoch-gated transaction; protection outlives the extension's source and loader scope until explicitly retired. */
export const registerProtectedSqlTable = (
	sql: SqlClient.SqlClient,
	name: string,
	owner?: { readonly extension: string; readonly migration: string },
) =>
	Effect.gen(function* () {
		if (!validProtectedTableName(name)) return yield* new KernelError({ code: "extension_migration_invalid" });
		yield* initialize(sql);
		yield* sql`INSERT INTO protected_sql_tables(name,extension,migration) VALUES(${name.toLowerCase()},${owner?.extension ?? null},${owner?.migration ?? null}) ${on(
			sql,
			{
				sqlite: () => sql`ON CONFLICT(name) DO NOTHING`,
				pg: () => sql`ON CONFLICT(name) DO NOTHING`,
				mysql: () => sql`ON DUPLICATE KEY UPDATE name=name`,
			},
		)}`;
	});

/** Load under the mutation writer lock so migration registration cannot race the guards. */
export const protectedSqlTables = (sql: SqlClient.SqlClient) =>
	Effect.gen(function* () {
		yield* initialize(sql);
		const rows = yield* sql`SELECT name FROM protected_sql_tables`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))),
		);
		if (rows.some(({ name }) => !validProtectedTableName(name)))
			return yield* new KernelError({ code: "sql_unsupported" });
		return [...new Set([...kernelSqlTables, ...rows.map(({ name }) => name.toLowerCase())])];
	});
