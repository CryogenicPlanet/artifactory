import { Schema } from "effect";
export const Message = Schema.Struct({
	id: Schema.String,
	seq: Schema.Int,
	topic: Schema.String,
	agent: Schema.String,
	instance: Schema.String,
	body: Schema.String,
	tags: Schema.Array(Schema.String),
	meta: Schema.JsonObject,
	created_at: Schema.Int,
	edited_at: Schema.NullOr(Schema.Int),
	deleted_at: Schema.NullOr(Schema.Int),
});
export const Envelope = Schema.Struct({
	items: Schema.Array(Message),
	cursor: Schema.Int,
	timed_out: Schema.Boolean,
	drained: Schema.Boolean,
});
export const MessageInput = Schema.Struct({
	topic: Schema.String,
	body: Schema.String,
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	meta: Schema.optionalKey(Schema.JsonObject),
});
