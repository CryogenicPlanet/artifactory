import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export class TopicMoveError extends Schema.TaggedError<TopicMoveError>()("TopicMoveError", {
	code: Schema.String,
}) {}
export const TopicMoveRow = Schema.Struct({
	id: Schema.String,
	from_path: Schema.String,
	to_path: Schema.String,
	instance: Schema.String,
	request_key: Schema.NullOr(Schema.String),
	request_hash: Schema.String,
	state: Schema.Literals(["prepared", "pages_published", "completed", "aborted"]),
	seq: Schema.NullOr(Schema.Int),
});
export const topicMoveSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE topic_moves (
		id TEXT PRIMARY KEY,from_path TEXT NOT NULL,to_path TEXT NOT NULL,instance TEXT NOT NULL,
		request_key TEXT,request_hash TEXT NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('prepared','pages_published','completed','aborted')),seq INTEGER)`;
	yield* sql`CREATE UNIQUE INDEX topic_moves_retry ON topic_moves(instance,request_key)
		WHERE request_key IS NOT NULL AND state<>'aborted'`;
});
export const validMovePath = (name: string) =>
	name.length <= 200 && /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(name);
