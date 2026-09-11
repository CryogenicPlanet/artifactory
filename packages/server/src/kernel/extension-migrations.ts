import { Crypto, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import { registerProtectedSqlTable } from "./protected-sql-tables.ts";
import { writerGate } from "./database.ts";

/** Loader-only migrations share the startup writer fence; they never publish candidate events. */
export const makeExtensionMigrate = (sql: SqlClient.SqlClient, epoch: string, extension: string) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		return (name: string, statement: string, options?: { readonly protect?: boolean }) =>
			Effect.gen(function* () {
				if (
					!name ||
					name.length > 128 ||
					Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
				)
					return yield* new KernelError({ code: "extension_migration_invalid" });
				// Bun's SQL client executes only the first statement. Refuse scripts rather than record a partial migration.
				if (
					Buffer.byteLength(statement) > 65536 ||
					statement.includes("\0") ||
					/;|--|\/\*/.test(statement) ||
					!/^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|WITH)\b/i.test(statement)
				)
					return yield* new KernelError({ code: "extension_migration_invalid" });
				const table = options?.protect
					? /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]{0,127})\s*\(/i.exec(statement)?.[1]
					: undefined;
				if (options?.protect && table === undefined)
					return yield* new KernelError({ code: "extension_migration_invalid" });
				const checksum = Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(statement))).toString(
					"hex",
				);
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* writerGate(sql, epoch);
						yield* sql`CREATE TABLE IF NOT EXISTS extension_migrations(extension TEXT NOT NULL,name TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(extension,name))`;
						const previous =
							yield* sql`SELECT checksum FROM extension_migrations WHERE extension=${extension} AND name=${name}`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ checksum: Schema.String })))),
							);
						if (previous.length > 0) {
							if (previous[0]?.checksum !== checksum)
								return yield* new KernelError({ code: "extension_migration_conflict" });
							return;
						}
						// IF NOT EXISTS must not turn a no-op into ownership of another table.
						if (
							table !== undefined &&
							(yield* sql`SELECT name FROM sqlite_schema WHERE name=${table} COLLATE NOCASE`).length
						)
							return yield* new KernelError({ code: "extension_migration_invalid" });
						yield* sql.unsafe(statement);
						if (table !== undefined) yield* registerProtectedSqlTable(sql, table);
						yield* sql`INSERT INTO extension_migrations(extension,name,checksum) VALUES(${extension},${name},${checksum})`;
					}),
				);
			});
	});
