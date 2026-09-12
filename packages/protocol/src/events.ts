import { Schema } from "effect";
export const EventRecord = Schema.Struct({
	seq: Schema.Int,
	at: Schema.Int,
	type: Schema.String,
	level: Schema.Literals(["debug", "info", "warn", "error"]),
	actor: Schema.String,
	instance: Schema.NullOr(Schema.String),
	generation: Schema.Int,
	request_id: Schema.NullOr(Schema.String),
	topic: Schema.NullOr(Schema.String),
	message_id: Schema.NullOr(Schema.String),
	payload: Schema.Json,
});
export const EventPage = Schema.Struct({
	items: Schema.Array(EventRecord),
	cursor: Schema.Int,
	timed_out: Schema.Boolean,
	drained: Schema.Boolean,
});
