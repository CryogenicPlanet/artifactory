import { on } from "@comms/storage/dialect";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { assertNoPendingMigration } from "./migration-intent.ts";
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
				yield* sql`CREATE TABLE IF NOT EXISTS kernel_migration_intent(singleton INTEGER PRIMARY KEY CHECK(singleton=1),scope VARCHAR(255) NOT NULL,name VARCHAR(255) NOT NULL,epoch VARCHAR(128) NOT NULL)`;
				yield* assertNoPendingMigration(sql);
				for (const statement of [
					sql`CREATE TABLE IF NOT EXISTS protected_sql_tables(name VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY)`,
					sql`CREATE TABLE IF NOT EXISTS extension_migrations(extension VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,name VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,checksum VARCHAR(64) NOT NULL,PRIMARY KEY(extension,name))`,
					sql`CREATE TABLE IF NOT EXISTS migrations(migration_id INTEGER UNSIGNED PRIMARY KEY,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,name VARCHAR(255) NOT NULL)`,
				]) {
					yield* sql.withTransaction(writerGate(sql, epoch));
					yield* statement;
				}
			}),
	});
