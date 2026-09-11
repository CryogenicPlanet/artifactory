import { sqlGroup, sqlHandlers } from "./sql-http.ts";
import { profilesGroup, profilesHandlers } from "./profiles-http.ts";
import { context } from "./context.ts";
import type { Extensions } from "./kernel/ext.ts";
import { description } from "./extension-http.ts";
import { routes as onboardingRoutes } from "./onboarding.ts";
import { DateTime, Effect, Layer, Ref, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/unstable/httpapi";
import { identity, failure, integer } from "./conversation-request.ts";
import { topicManagementGroup, topicManagementHandlers } from "./topic-management-http.ts";
import { reactionGroup, reactionHandlers } from "./reaction-http.ts";
import { searchGroup, searchHandlers } from "./search-http.ts";
import { messageGroup, messageHandlers } from "./message-http.ts";
import { topicsGroup, topicHandlers } from "./topics-http.ts";
import { Lifecycle } from "./kernel/lifecycle.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { Envelope, Message, MessageInput, Messages, validTopic } from "./kernel/messages.ts";

const query = Object.freeze({
	since: Schema.optionalKey(Schema.String),
	topic: Schema.optionalKey(Schema.String),
	recursive: Schema.optionalKey(Schema.String),
	tag: Schema.optionalKey(Schema.String),
	agent: Schema.optionalKey(Schema.String),
	q: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(Schema.String),
	wait: Schema.optionalKey(Schema.String),
});
export const Api = HttpApi.make("comms")
	.add(sqlGroup)
	.add(profilesGroup)
	.add(topicsGroup)
	.add(topicManagementGroup)
	.add(messageGroup)
	.add(searchGroup)
	.add(reactionGroup)
	.add(
		HttpApiGroup.make("conversation").add(
			HttpApiEndpoint.post("create", "/api/messages", { payload: MessageInput, success: Message }).annotate(
				OpenApi.Description,
				"Create a markdown message and missing topic ancestors. Requires write. Idempotency-Key is scoped to the authenticated instance. Success follows durable event publication.",
			),
			HttpApiEndpoint.get("messages", "/api/messages", { query, success: Envelope }).annotate(
				OpenApi.Description,
				"Read published messages in sequence order. Combine exact tag and agent filters with literal full-text q words/phrases. Requires read. Omitted since starts now; since=0 reads history. wait up to 60 seconds excludes this instance, with whitespace heartbeats and a preserved empty cursor.",
			),
			HttpApiEndpoint.get("context", "/api/ctx", {
				query: {
					topic: Schema.optionalKey(Schema.String),
					since: Schema.optionalKey(Schema.String),
					budget: Schema.optionalKey(Schema.String),
				},
				success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/markdown" })),
			}).annotate(
				OpenApi.Description,
				"Read a bounded markdown digest: README, metadata, pinned/open messages, subtopic summaries, pages and caller unread/inbox. Requires read. Latest 200 message window; approximate four UTF-16 code units per token, with explicit truncation. since filters ordinary recent messages, not standing context.",
			),
		),
	);
const handlers = HttpApiBuilder.group(Api, "conversation", (handlers) =>
	handlers
		.handleRaw("create", () =>
			failure(
				Effect.gen(function* () {
					const who = yield* identity("write");
					const request = yield* HttpServerRequest.HttpServerRequest;
					let bytes = 0;
					const chunks = yield* request.stream.pipe(
						Stream.tap((chunk) =>
							Effect.gen(function* () {
								bytes += chunk.byteLength;
								if (bytes > 131072) return yield* new KernelError({ code: "input_invalid" });
							}),
						),
						Stream.runCollect,
						Effect.timeout("5 seconds"),
					);
					const text = Buffer.concat(chunks).toString("utf8");
					const input = yield* Schema.decodeEffect(Schema.fromJsonString(MessageInput))(text).pipe(
						Effect.mapError(() => new KernelError({ code: "input_invalid" })),
					);
					return HttpServerResponse.jsonUnsafe(
						yield* (yield* Messages).create(who, input, request.headers["idempotency-key"]),
					);
				}),
			),
		)
		.handleRaw("messages", () =>
			failure(
				Effect.gen(function* () {
					const who = yield* identity("read");
					const request = yield* HttpServerRequest.HttpServerRequest;
					const params = new URL(request.url, "http://localhost").searchParams;
					if ([...params.keys()].some((key) => !Object.keys(query).includes(key) || params.getAll(key).length !== 1))
						return yield* new KernelError({ code: "query_invalid" });
					const since = integer(params.get("since"), -1, Number.MAX_SAFE_INTEGER),
						limit = integer(params.get("limit"), 100, 200),
						wait = integer(params.get("wait"), 0, 60),
						topic = params.get("topic"),
						recursive = params.get("recursive");
					if (
						(since === null && params.has("since")) ||
						limit === null ||
						limit === 0 ||
						wait === null ||
						(topic !== null && !validTopic(topic)) ||
						(recursive !== null && recursive !== "0" && recursive !== "1")
					)
						return yield* new KernelError({ code: "query_invalid" });
					const messages = yield* Messages;
					const cursor = params.has("since") && since !== null ? since : (yield* messages.fence).published_through;
					const input = {
						since: cursor,
						limit,
						...(topic === null ? {} : { topic }),
						recursive: recursive === "1",
						...(params.has("tag") ? { tag: params.get("tag") ?? "" } : {}),
						...(params.has("agent") ? { agent: params.get("agent") ?? "" } : {}),
						...(params.has("q") ? { q: params.get("q") ?? "" } : {}),
						...(wait > 0 ? { exclude: who.instance } : {}),
					};
					const first = yield* messages.list(input);
					if (first.items.length || wait === 0) return HttpServerResponse.jsonUnsafe(first);
					const lifecycle = yield* Lifecycle;
					const deadline = (yield* DateTime.nowAsDate).getTime() + wait * 1000;
					const result = Effect.gen(function* () {
						while ((yield* DateTime.nowAsDate).getTime() < deadline) {
							if ((yield* Ref.get(lifecycle.state)) === "draining") return { ...first, drained: true };
							yield* Effect.sleep("100 millis");
							const next = yield* messages.list(input);
							if (next.items.length) return next;
						}
						return { ...first, timed_out: true };
					});
					const encoder = new TextEncoder();
					return HttpServerResponse.stream(
						Stream.merge(
							Stream.fromEffect(result.pipe(Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Envelope))))),
							Stream.tick("10 seconds").pipe(Stream.map(() => "\n")),
							{ haltStrategy: "left" },
						).pipe(Stream.map((value) => encoder.encode(value))),
						{ contentType: "application/json" },
					);
				}),
			),
		)
		.handleRaw("context", () => failure(context)),
);
export const routes = (extensions: Extensions["Service"]) =>
	Layer.mergeAll(
		HttpRouter.add(
			"GET",
			"/api/ext",
			failure(
				Effect.gen(function* () {
					yield* identity("read");
					return HttpServerResponse.jsonUnsafe(yield* extensions.status);
				}),
			),
		),
		HttpApiBuilder.layer(Api).pipe(
			Layer.provide(
				Layer.mergeAll(
					handlers,
					sqlHandlers(Api),
					profilesHandlers(Api),
					topicHandlers(Api),
					messageHandlers(Api),
					searchHandlers(Api),
					reactionHandlers(Api),
					topicManagementHandlers(Api),
				),
			),
		),
		HttpRouter.add(
			"GET",
			"/api",
			Effect.gen(function* () {
				yield* identity("read");
				return HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Api.add(description(extensions))));
			}).pipe(failure),
		),
		onboardingRoutes(OpenApi.fromApi(Api.add(description(extensions))).paths),
	);
