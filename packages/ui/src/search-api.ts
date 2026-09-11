import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { BoardError, json, Message } from "./board-api.ts";

export type MessageFilters = {
	readonly q: string;
	readonly topic: string;
	readonly tag: string;
	readonly agent: string;
};
export const searchMessages = (filters: MessageFilters, since = 0) => {
	const url = new URL("/api/messages", window.location.origin);
	url.searchParams.set("since", String(since));
	url.searchParams.set("limit", "100");
	url.searchParams.set("recursive", "1");
	for (const [key, value] of Object.entries(filters)) if (value) url.searchParams.set(key, value);
	return json(HttpClientRequest.get(url.href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ items: Schema.Array(Message), cursor: Schema.Int }))),
		Effect.catchTag("SchemaError", () =>
			Effect.fail(new BoardError({ status: 0, message: "Search returned an unreadable result. Try again." })),
		),
	);
};
