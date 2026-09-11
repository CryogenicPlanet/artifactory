import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Included in boot schema v13 by the topic-move coordinator. */
export const topicPageMoveSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE topic_page_moves (
		id TEXT PRIMARY KEY, from_path TEXT NOT NULL, to_path TEXT NOT NULL, agent TEXT NOT NULL,
		tree TEXT, state TEXT NOT NULL CHECK(state IN ('prepared','publishing','published','completed'))
	)`;
	yield* sql`CREATE UNIQUE INDEX topic_page_move_single_pending ON topic_page_moves ((1)) WHERE state != 'completed'`;
});
