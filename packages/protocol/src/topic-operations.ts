import { Schema } from "effect";
export const TopicMetaInput = Schema.Struct({ meta: Schema.JsonObject });
export const TopicArchiveInput = Schema.Struct({ archived: Schema.Boolean });
export const TopicMutation = Schema.Struct({
	path: Schema.String,
	meta: Schema.JsonObject,
	archived_at: Schema.NullOr(Schema.Int),
	seq: Schema.Int,
});
