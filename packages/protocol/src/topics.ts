import { Message } from "./messages.ts";
import { Schema } from "effect";
export const TopicSummary = Schema.Struct({
	path: Schema.String,
	name: Schema.String,
	meta: Schema.JsonObject,
	last_seq: Schema.Int,
	unread: Schema.Int,
	archived_at: Schema.NullOr(Schema.Int),
});
export const TopicResult = Schema.Struct({
	path: Schema.String,
	meta: Schema.JsonObject,
	archived_at: Schema.NullOr(Schema.Int),
	archived_by: Schema.NullOr(Schema.String),
	subtopics: Schema.Array(TopicSummary),
	messages: Schema.Array(Message),
	fence: Schema.Int,
	unread: Schema.Int,
	index: Schema.NullOr(Schema.String),
	pages: Schema.Array(Schema.String),
});
