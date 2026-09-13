import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { on } from "@comms/storage/dialect";

/** Presence alone requires the previous compatible image; never interpret or retire historical evidence. */
export const hasLegacyTopicMoves = (sql: SqlClient.SqlClient) =>
	on(sql, {
		sqlite: () => sql`SELECT 1 FROM sqlite_schema WHERE type='table'
 AND lower(name) IN ('topic_moves','topic_page_moves') LIMIT 1`,
		pg: () => sql`SELECT 1 FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p')
 AND lower(c.relname) IN ('topic_moves','topic_page_moves') LIMIT 1`,
		mysql: () => sql`SELECT 1 FROM information_schema.tables
 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'
 AND lower(TABLE_NAME) IN ('topic_moves','topic_page_moves') LIMIT 1`,
	}).pipe(Effect.map((rows) => rows.length > 0));
