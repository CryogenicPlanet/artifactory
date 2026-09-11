import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { BoardError, json } from "./board-api.ts";

const TopicMutation = Schema.Struct({
	path: Schema.String,
	meta: Schema.JsonObject,
	archived_at: Schema.NullOr(Schema.Int),
	seq: Schema.Int,
});
export type TopicMutation = typeof TopicMutation.Type;

export const saveTopic = (path: string, input: { readonly meta: Schema.JsonObject } | { readonly archived: boolean }) =>
	json(
		HttpClientRequest.make("meta" in input ? "PUT" : "PATCH")(
			new URL(`/api/topics/${path.split("/").map(encodeURIComponent).join("/")}`, window.location.origin).href,
		).pipe(HttpClientRequest.bodyJsonUnsafe(input)),
	).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(TopicMutation)),
		Effect.catchTag("SchemaError", () =>
			Effect.fail(new BoardError({ status: 0, message: "The board returned an unreadable topic update." })),
		),
	);
