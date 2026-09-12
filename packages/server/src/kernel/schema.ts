import { tableShape, type ColumnShape } from "@comms/storage/remote-migrations";
import { on } from "@comms/storage/dialect";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { assertNoPendingMigration } from "./migration-intent.ts";
import { KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";

/** Run after boot admits this writer, before core or editable migrations open a transaction.
 * MySQL DDL commits implicitly; PostgreSQL's Migrator probe cannot create a missing ledger in an outer transaction. */
export const initializeRemoteKernelSchema = (sql: SqlClient.SqlClient, epoch: string) =>
	on(sql, {
		sqlite: () => Effect.void,
		pg: () =>
			sql.withTransaction(
				Effect.gen(function* () {
					yield* writerGate(sql, epoch);
					yield* sql`CREATE TABLE IF NOT EXISTS protected_sql_tables(name VARCHAR(128) PRIMARY KEY)`;
					yield* sql`CREATE TABLE IF NOT EXISTS extension_migrations(extension VARCHAR(255) NOT NULL,name VARCHAR(128) NOT NULL,checksum VARCHAR(64) NOT NULL,PRIMARY KEY(extension,name))`;
					yield* sql`CREATE TABLE IF NOT EXISTS migrations(migration_id INTEGER PRIMARY KEY,created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),name TEXT NOT NULL)`;
				}),
			),
		mysql: () =>
			Effect.gen(function* () {
				yield* sql.withTransaction(writerGate(sql, epoch));
				// Boot creates this under its independent initialization journal. Missing evidence is never fresh state.
				yield* assertNoPendingMigration(sql);
				const text = (name: string, length: number): ColumnShape => ({
					name,
					type: "varchar",
					length,
					nullable: false,
					default: null,
					expression: "",
					collation: "utf8mb4_0900_bin",
				});
				for (const table of [
					{
						name: "protected_sql_tables",
						columns: [text("name", 128)],
						primary: ["name"],
						create: sql`CREATE TABLE IF NOT EXISTS protected_sql_tables(name VARCHAR(128) PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
					},
					{
						name: "extension_migrations",
						columns: [text("extension", 255), text("name", 128), text("checksum", 64)],
						primary: ["extension", "name"],
						create: sql`CREATE TABLE IF NOT EXISTS extension_migrations(extension VARCHAR(255) NOT NULL,name VARCHAR(128) NOT NULL,checksum VARCHAR(64) NOT NULL,PRIMARY KEY(extension,name)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
					},
					{
						name: "migrations",
						columns: [
							{ name: "migration_id", type: "int", nullable: false, default: null, expression: "" },
							{ name: "created_at", type: "timestamp", nullable: false, expression: "" },
							text("name", 255),
						],
						primary: ["migration_id"],
						create: sql`CREATE TABLE IF NOT EXISTS migrations(migration_id INTEGER UNSIGNED PRIMARY KEY,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,name VARCHAR(255) NOT NULL) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
					},
				]) {
					yield* sql.withTransaction(writerGate(sql, epoch));
					const shape = tableShape(sql, table.name, table.columns, table.primary, { checks: [], foreignKeys: [] }).pipe(
						Effect.mapError(() => new KernelError({ code: "migration_recovery_required" })),
					);
					if (!(yield* shape)) {
						yield* table.create;
						if (!(yield* shape)) return yield* new KernelError({ code: "migration_recovery_required" });
					}
				}
			}),
	});
