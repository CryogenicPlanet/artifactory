import { RequestValidation, layer as bodyLayer } from "./request-schema.ts";
import { sqlGroup, sqlHandlers } from "./sql-http.ts";
import { profilesGroup, profilesHandlers } from "./profiles-http.ts";
import type { Extensions } from "./kernel/ext.ts";
import { routes as onboardingRoutes } from "./onboarding.ts";
import { DateTime, Deferred, Effect, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { identity, failure, integer } from "./conversation-request.ts";
import { topicManagementGroup, topicManagementHandlers } from "./topic-management-http.ts";
import { messageGroup, messageHandlers } from "./message-http.ts";
import { topicsGroup, topicHandlers } from "./topics-http.ts";
import { Lifecycle } from "./kernel/lifecycle.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { Envelope, Message, MessageInput, Messages, validTopic } from "./kernel/messages.ts";
import { waitForMessages } from "./kernel/message-wait.ts";
import { markView } from "./read-view.ts";

const flag = Schema.optionalKey(Schema.Literals(["0", "1"]));
const query = Schema.Struct({
	since: Schema.optionalKey(Schema.String),
	topic: Schema.optionalKey(Schema.String),
	recursive: flag,
	tag: Schema.optionalKey(Schema.String),
	agent: Schema.optionalKey(Schema.String),
	q: Schema.optionalKey(Schema.String),
	mentions: Schema.optionalKey(Schema.String),
	exclude_self: flag,
	newest: flag,
	mark: flag,
	limit: Schema.optionalKey(Schema.String),
	wait: Schema.optionalKey(Schema.String),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const conversationGroup = HttpApiGroup.make("conversation").add(
	HttpApiEndpoint.post("create", "/api/messages", {
		payload: MessageInput.annotate({ parseOptions: { onExcessProperty: "error" } }),
		success: Message,
	}).annotate(
		OpenApi.Description,
		"Create a markdown message and missing topic ancestors. Requires write. Idempotency-Key is scoped to the authenticated instance. Success follows durable event publication.",
	),
	HttpApiEndpoint.get("messages", "/api/messages", { query, success: Envelope }).annotate(
		OpenApi.Description,
		"Read published messages. since is exclusive and defaults to now; since=0 reads history. newest=1 returns latest limit in ascending sequence order. topic/subtree OR comma-list mentions selects addressed messages; other filters combine with AND. exclude_self=1 and waits exclude this instance. cursor is considered-through, including empty results. Views mark highest returned seq at topic or root; mark=0 peeks. wait up to60 seconds sends whitespace heartbeats and drains on swap.",
	),
);
const boundedConversationGroup = conversationGroup.middleware(RequestValidation);
export const Api = HttpApi.make("comms")
	.add(topicsGroup)
	.add(topicManagementGroup)
	.add(messageGroup)
	.add(boundedConversationGroup);
export const CoreApi = Api;
export const SystemApi = HttpApi.make("comms-system").add(sqlGroup).add(profilesGroup);
const handlers = HttpApiBuilder.group(Api, "conversation", (handlers) =>
	handlers
		.handle("create", ({ payload, request }) =>
			failure(
				Effect.gen(function* () {
					const who = yield* identity("write");
					return yield* (yield* Messages).create(who, payload, request.headers["idempotency-key"]);
				}),
			),
		)
		.handle("messages", ({ query }) =>
			failure(
				Effect.gen(function* () {
					const who = yield* identity("read");
					const limit = integer(query.limit ?? null, 100, 200),
						wait = integer(query.wait ?? null, 0, 60),
						parsedSince = integer(query.since ?? null, 0, Number.MAX_SAFE_INTEGER);
					if (
						limit === null ||
						limit === 0 ||
						wait === null ||
						parsedSince === null ||
						(query.topic !== undefined && !validTopic(query.topic)) ||
						(query.newest === "1" && wait > 0)
					)
						return yield* new KernelError({ code: "query_invalid" });
					const messages = yield* Messages;
					const cursor =
						query.since !== undefined
							? parsedSince
							: query.newest === "1"
								? 0
								: (yield* messages.fence).published_through;
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
						...(wait > 0 || query.exclude_self === "1" ? { exclude: who.instance } : {}),
					};
					const view = (result: typeof Envelope.Type) =>
						markView(who, result.items, query.topic ?? "", query.mark !== "0").pipe(Effect.as(result));
					const first = yield* messages.list(input);
					if (first.items.length || wait === 0) return yield* view(first);
					const lifecycle = yield* Lifecycle;
					const deadline = (yield* DateTime.nowAsDate).getTime() + wait * 1000;
					const result = waitForMessages({
						first,
						deadline,
						changed: messages.changed,
						query: (since) => messages.list({ ...input, since }),
						view,
						drained: Deferred.await(lifecycle.drained),
					});
					const environment = yield* Effect.context<Messages | Lifecycle>();
					const encoder = new TextEncoder();
					return HttpServerResponse.stream(
						Stream.merge(
							Stream.fromEffect(
								result.pipe(
									Effect.provideContext(environment),
									Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Envelope))),
								),
							),
							Stream.tick("10 seconds").pipe(Stream.map(() => "\n")),
							{ haltStrategy: "left" },
						).pipe(Stream.map((value) => encoder.encode(value))),
						{ contentType: "application/json" },
					);
				}),
			),
		),
).pipe(Layer.provide(bodyLayer(131072)));
export const coreHandlers = Layer.mergeAll(
	handlers,
	topicHandlers(Api),
	messageHandlers(Api),
	topicManagementHandlers(Api),
);
export const routes = (extensions: Extensions["Service"]) => {
	const system = OpenApi.fromApi(SystemApi);
	const specification = {
		...system,
		paths: Object.fromEntries(
			[...new Set([...Object.keys(system.paths), ...Object.keys(extensions.openapi.paths)])].map((path) => [
				path,
				{ ...system.paths[path], ...extensions.openapi.paths[path] },
			]),
		),
		components: {
			schemas: { ...extensions.openapi.components.schemas, ...system.components.schemas },
			securitySchemes: { ...extensions.openapi.components.securitySchemes, ...system.components.securitySchemes },
		},
	};
	return Layer.mergeAll(
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
		HttpApiBuilder.layer(SystemApi).pipe(
			Layer.provide(Layer.mergeAll(sqlHandlers(SystemApi), profilesHandlers(SystemApi))),
		),
		HttpRouter.add(
			"GET",
			"/api",
			Effect.gen(function* () {
				yield* identity("read");
				return HttpServerResponse.jsonUnsafe(specification);
			}).pipe(failure),
		),
		onboardingRoutes(specification),
	);
};
