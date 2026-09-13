import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";

export const kernelSqlTables = Object.freeze([
	"kernel_writer",
	"store_identity",
	"mutation_batches",
	"outbox",
	"idempotency",
	"extension_migrations",
	"protected_sql_tables",
]);
const validName = (name: string) => /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(name);
const initialize = (sql: SqlClient.SqlClient) =>
	sql`CREATE TABLE IF NOT EXISTS protected_sql_tables(name TEXT PRIMARY KEY COLLATE NOCASE)`;

/** Called inside an epoch-gated transaction; protection outlives the extension's source and loader scope. */
export const registerProtectedSqlTable = (sql: SqlClient.SqlClient, name: string) =>
	Effect.gen(function* () {
		if (!validName(name)) return yield* new KernelError({ code: "extension_migration_invalid" });
		yield* initialize(sql);
		yield* sql`INSERT OR IGNORE INTO protected_sql_tables(name) VALUES(${name.toLowerCase()})`;
	});

/** Load under the mutation writer lock so migration registration cannot race the guards. */
export const protectedSqlTables = (sql: SqlClient.SqlClient) =>
	Effect.gen(function* () {
		yield* initialize(sql);
		const rows = yield* sql`SELECT name FROM protected_sql_tables`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))),
		);
		if (rows.some(({ name }) => !validName(name))) return yield* new KernelError({ code: "sql_unsupported" });
		return [...new Set([...kernelSqlTables, ...rows.map(({ name }) => name.toLowerCase())])];
	});
