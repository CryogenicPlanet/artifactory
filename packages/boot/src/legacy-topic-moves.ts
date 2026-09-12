import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/** Presence alone requires the previous compatible image; never interpret or retire historical evidence. */
export const hasLegacyTopicMoves = (sql: SqlClient.SqlClient) =>
	sql`SELECT 1 FROM sqlite_schema WHERE type='table'
	AND lower(name) IN ('topic_moves','topic_page_moves') LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0));
