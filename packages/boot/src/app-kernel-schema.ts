import { on } from "@comms/storage/dialect";
import type { SqlClient } from "effect/unstable/sql";

/** Fresh remote app-store DDL, executed with boot's credential only after closure and identity selection.
 * The caller owns durable per-operation progress on MySQL and must never use this to repair an initialized store. */
export const remoteAppKernelSchema = (sql: SqlClient.SqlClient, appRole: string) =>
	on(sql, {
		sqlite: () => [],
		pg: () => [
			sql`CREATE TABLE IF NOT EXISTS kernel_writer(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL)`,
			sql`CREATE TABLE IF NOT EXISTS mutation_batches(id TEXT PRIMARY KEY,from_seq BIGINT NOT NULL,to_seq BIGINT NOT NULL,count BIGINT NOT NULL)`,
			sql`CREATE TABLE IF NOT EXISTS outbox(seq BIGINT PRIMARY KEY,transaction_id TEXT NOT NULL,event TEXT NOT NULL,shipped_at BIGINT)`,
			sql`CREATE TABLE IF NOT EXISTS store_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id TEXT NOT NULL,initialized_at BIGINT NOT NULL,transferred_to TEXT)`,
			sql`GRANT SELECT,INSERT,UPDATE,DELETE ON kernel_writer,mutation_batches,outbox TO ${sql(appRole)}`,
			sql`GRANT SELECT ON store_identity TO ${sql(appRole)}`,
		],
		mysql: () => [
			sql`CREATE TABLE IF NOT EXISTS kernel_writer(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL)`,
			sql`CREATE TABLE IF NOT EXISTS mutation_batches(id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY,from_seq BIGINT NOT NULL,to_seq BIGINT NOT NULL,count BIGINT NOT NULL)`,
			sql`CREATE TABLE IF NOT EXISTS outbox(seq BIGINT PRIMARY KEY,transaction_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,event LONGTEXT NOT NULL,shipped_at BIGINT)`,
			sql`CREATE TABLE IF NOT EXISTS store_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id VARCHAR(36) NOT NULL,initialized_at BIGINT NOT NULL,transferred_to TEXT)`,
		],
	});
