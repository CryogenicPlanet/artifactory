import { Schema } from "effect";
export const MessagePatch = Schema.Struct({
	body: Schema.optionalKey(Schema.String),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	meta: Schema.optionalKey(Schema.JsonObject),
});
