import { Schema } from "effect";
export const TopicMove = Schema.Struct({ from: Schema.String, to: Schema.String, seq: Schema.Int });
