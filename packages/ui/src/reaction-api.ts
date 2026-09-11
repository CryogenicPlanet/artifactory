import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { BoardError, json } from "./board-api.ts";

const Reaction = Schema.Struct({ instance: Schema.String, emoji: Schema.String });
const ReactionList = Schema.Struct({ items: Schema.Array(Reaction), cursor: Schema.Int });
const ReactionResult = Schema.Struct({
	...Reaction.fields,
	message: Schema.String,
	active: Schema.Boolean,
	seq: Schema.Int,
});
export type MessageReaction = typeof Reaction.Type;
export type PendingReaction = {
	readonly message: string;
	readonly emoji: string;
	readonly key: string;
};
const unreadable = () =>
	Effect.fail(new BoardError({ status: 0, message: "The board returned an unreadable reaction response." }));
export const getReactions = (message: string) =>
	json(
		HttpClientRequest.get(
			new URL(`/api/reactions?message=${encodeURIComponent(message)}`, window.location.origin).href,
		),
	).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ReactionList)), Effect.catchTag("SchemaError", unreadable));
export const toggleReaction = (reaction: PendingReaction) =>
	json(
		HttpClientRequest.post(new URL("/api/reactions", window.location.origin).href).pipe(
			HttpClientRequest.setHeader("Idempotency-Key", reaction.key),
			HttpClientRequest.bodyJsonUnsafe({ message: reaction.message, emoji: reaction.emoji }),
		),
	).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ReactionResult)), Effect.catchTag("SchemaError", unreadable));
