import { errorSchemas } from "../../error-contract.ts";
import { QueryCursor, QueryLimit, queryInteger } from "../../query-number.ts";
import type { Api as ExtensionApi } from "../../kernel/extension-api.ts";
import { streamGroup, streamHandlers } from "../../stream-http.ts";
import { RequestValidation, layer as bodyLayer } from "../../request-schema.ts";
import { profilesGroup, profilesHandlers } from "./profiles-http.ts";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { refusal } from "../../conversation-request.ts";
import { topicManagementGroup, topicManagementHandlers } from "./topic-management-http.ts";
import { messageGroup, messageHandlers } from "./message-http.ts";
import { topicsGroup, topicHandlers } from "./topics-http.ts";
import { KernelError } from "../../kernel/boot-channel.ts";
import { Envelope, Message, MessageInput, validTopic } from "./messages.ts";
import { waitForMessages } from "./message-wait.ts";
import { markView } from "./read-view.ts";

const flag = Schema.optionalKey(Schema.Literals(["0", "1"]));
const query = Schema.Struct({
	since: Schema.optionalKey(QueryCursor),
	topic: Schema.optionalKey(Schema.String),
	recursive: flag,
	tag: Schema.optionalKey(Schema.String),
	agent: Schema.optionalKey(Schema.String),
	q: Schema.optionalKey(Schema.String),
	mentions: Schema.optionalKey(Schema.String),
	exclude_self: flag,
	newest: flag,
	mark: flag,
	limit: Schema.optionalKey(QueryLimit),
	wait: Schema.optionalKey(queryInteger(0, 60)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const conversationGroup = HttpApiGroup.make("conversation").add(
	HttpApiEndpoint.post("create", "/api/messages", {
		error: errorSchemas,
		payload: MessageInput.annotate({ parseOptions: { onExcessProperty: "error" } }),
		success: Message,
	}).annotate(
		OpenApi.Description,
		"Create a markdown message and missing topic ancestors. Requires write. Idempotency-Key is scoped to the authenticated instance. Success follows durable event publication.",
	),
	HttpApiEndpoint.get("messages", "/api/messages", { error: errorSchemas, query, success: Envelope }).annotate(
		OpenApi.Description,
		"Read published messages. since is exclusive and defaults to now; since=0 reads history. newest=1 returns latest limit in ascending sequence order. topic/subtree OR comma-list mentions selects addressed messages; other filters combine with AND. exclude_self=1 and waits exclude this instance. cursor is considered-through, including empty results. Views mark highest returned seq at topic or root; mark=0 peeks. wait up to60 seconds sends whitespace heartbeats and drains on swap.",
	),
);
const boundedConversationGroup = conversationGroup.middleware(RequestValidation);
export const Api = HttpApi.make("comms")
	.add(topicsGroup)
	.add(topicManagementGroup)
	.add(messageGroup)
	.add(profilesGroup)
	.add(streamGroup)
	.add(boundedConversationGroup);
const handlers = (extension: ExtensionApi) =>
	HttpApiBuilder.group(Api, "conversation", (handlers) =>
		handlers
			.handle("create", ({ payload, request }) =>
				refusal(
					Effect.gen(function* () {
						const ctx = yield* extension.context("write");
						return yield* ctx.messages.create(payload, request.headers["idempotency-key"]);
					}),
				),
			)
			.handle("messages", ({ query }) =>
				refusal(
					Effect.gen(function* () {
						const ctx = yield* extension.context("read");
						const limit = query.limit ?? 100,
							wait = query.wait ?? 0;
						if ((query.topic !== undefined && !validTopic(query.topic)) || (query.newest === "1" && wait > 0))
							return yield* new KernelError({ code: "query_invalid" });
						const cursor =
							query.since !== undefined
								? query.since
								: query.newest === "1"
									? 0
									: (yield* ctx.publicationFence).published_through;
						const input = {
							since: cursor,
							limit,
							...(query.topic === undefined ? {} : { topic: query.topic }),
							recursive: query.recursive === "1",
							newest: query.newest === "1",
							...(query.tag === undefined ? {} : { tag: query.tag }),
							...(query.agent === undefined ? {} : { agent: query.agent }),
							...(query.q === undefined ? {} : { q: query.q }),
							...(query.mentions === undefined ? {} : { mentions: query.mentions.split(",") }),
							...(wait > 0 || query.exclude_self === "1" ? { exclude: ctx.instance } : {}),
						};
						const view = (result: typeof Envelope.Type) =>
							markView(ctx, result.items, query.topic ?? "", query.mark !== "0").pipe(Effect.as(result));
						const first = yield* ctx.messages.query(input);
						if (first.items.length || wait === 0) return yield* view(first);
						const deadline = (yield* DateTime.nowAsDate).getTime() + wait * 1000;
						const result = waitForMessages({
							first,
							deadline,
							changed: ctx.events.changed,
							query: (since) => ctx.messages.query({ ...input, since }),
							view,
							drained: ctx.drained,
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
			),
	).pipe(Layer.provide(bodyLayer(131072)));
export const coreHandlers = (extension: ExtensionApi) =>
	Layer.mergeAll(
		handlers(extension),
		topicHandlers(Api, extension),
		messageHandlers(Api, extension),
		topicManagementHandlers(Api, extension),
		profilesHandlers(Api, extension),
		streamHandlers(Api, extension),
	);
