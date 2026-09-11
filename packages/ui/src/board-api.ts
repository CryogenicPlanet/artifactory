import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

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
});
const Topic = Schema.Struct({
	path: Schema.String,
	meta: Schema.JsonObject,
	archived_at: Schema.NullOr(Schema.Int),
	archived_by: Schema.NullOr(Schema.String),
	subtopics: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			name: Schema.String,
			meta: Schema.JsonObject,
			last_seq: Schema.Int,
			unread: Schema.Int,
			archived_at: Schema.NullOr(Schema.Int),
		}),
	),
	index: Schema.NullOr(Schema.String),
	pages: Schema.Array(Schema.String),
	messages: Schema.Array(Message),
	fence: Schema.Int,
	unread: Schema.Int,
});
const ErrorBody = Schema.Struct({
	error: Schema.Struct({ message: Schema.String, hint: Schema.optionalKey(Schema.String) }),
});
export type BoardMessage = typeof Message.Type;
export type BoardTopic = typeof Topic.Type;
export class BoardError extends Schema.TaggedError<BoardError>()("BoardError", {
	status: Schema.Int,
	message: Schema.String,
}) {}

export const json = (request: HttpClientRequest.HttpClientRequest) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const response = yield* client.execute(request);
		if (response.status < 200 || response.status >= 300) {
			const detail = yield* response.json.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
				Effect.map((body) => body.error.message),
				Effect.orElseSucceed(() => "The board could not complete this request."),
			);
			return yield* new BoardError({ status: response.status, message: detail });
		}
		return yield* response.json;
	}).pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.timeoutOrElse({
			duration: "15 seconds",
			orElse: () =>
				Effect.fail(new BoardError({ status: 0, message: "The board took too long to respond. Try again." })),
		}),
		Effect.catchTag("HttpClientError", () =>
			Effect.fail(
				new BoardError({ status: 0, message: "Could not reach the board. Check your connection and try again." }),
			),
		),
	);

export const getTopic = (path: string, archived = false, mark = true) => {
	const url = new URL(
		path ? `/api/topics/${path.split("/").map(encodeURIComponent).join("/")}` : "/api/topics",
		window.location.origin,
	);
	if (archived) url.searchParams.set("archived", "1");
	if (!mark) url.searchParams.set("mark", "0");
	return json(HttpClientRequest.get(url.href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Topic)),
		Effect.catchTag("SchemaError", () =>
			Effect.fail(new BoardError({ status: 0, message: "The board returned an unreadable topic. Try refreshing." })),
		),
	);
};
export type PendingMessage = { readonly topic: string; readonly body: string; readonly key: string };
export const sendMessage = (message: PendingMessage) =>
	json(
		HttpClientRequest.post(new URL("/api/messages", window.location.origin).href).pipe(
			HttpClientRequest.setHeader("Idempotency-Key", message.key),
			HttpClientRequest.bodyJsonUnsafe({ topic: message.topic, body: message.body }),
		),
	).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Message)),
		Effect.catchTag("SchemaError", () =>
			Effect.fail(
				new BoardError({
					status: 0,
					message: "The reply was unreadable. Retry the same message to confirm it was saved.",
				}),
			),
		),
	);
export const topicHref = (path: string) => (path ? `/t/${path.split("/").map(encodeURIComponent).join("/")}` : "/");
export const validTopic = (path: string) =>
	path.length <= 200 && /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(path);

export const getMessageBySequence = (seq: number) =>
	json(
		HttpClientRequest.get(new URL(`/api/messages?since=${seq - 1}&limit=1&mark=0`, window.location.origin).href),
	).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ items: Schema.Array(Message) }))),
		Effect.flatMap((result) =>
			result.items[0]?.seq === seq
				? Effect.succeed(result.items[0])
				: Effect.fail(new BoardError({ status: 404, message: `Message #${seq} is unavailable or deleted.` })),
		),
		Effect.catchTag("SchemaError", () =>
			Effect.fail(new BoardError({ status: 0, message: "The board returned an unreadable message." })),
		),
	);

export const getMessageHistory = (path: string, since: number) => {
	const url = new URL("/api/messages", window.location.origin);
	url.searchParams.set("topic", path);
	url.searchParams.set("since", String(since));
	url.searchParams.set("limit", "100");
	return json(HttpClientRequest.get(url.href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ items: Schema.Array(Message), cursor: Schema.Int }))),
		Effect.catchTag("SchemaError", () =>
			Effect.fail(new BoardError({ status: 0, message: "The board returned unreadable history. Try again." })),
		),
	);
};
