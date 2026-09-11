import { Pages } from "./kernel/pages.ts";
import { RequestValidation, layer as bodyLayer } from "./request-schema.ts";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./conversation.ts";
import { failure, identity } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { TopicMove } from "./kernel/topic-move.ts";
import { Messages } from "./kernel/messages.ts";
import { TopicArchiveInput, TopicMetaInput, TopicMutation } from "./kernel/topic-operations.ts";

const query = Schema.Record(Schema.String, Schema.Never);
const payload = Schema.Union([
	TopicMetaInput.annotate({ parseOptions: { onExcessProperty: "error" } }),
	TopicArchiveInput.annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export const topicManagementGroup = HttpApiGroup.make("topicManagement")
	.add(
		HttpApiEndpoint.post("move", "/api/topics/*", {
			query,
			payload: Schema.Struct({ to: Schema.String }),
			success: TopicMove,
		}).annotate(
			OpenApi.Description,
			"POST /api/topics/<path>/move with {to}. Requires write. Move a topic subtree to an absent destination; Idempotency-Key preserves the first outcome.",
		),
		HttpApiEndpoint.put("meta", "/api/topics/*", { query, payload, success: TopicMutation }).annotate(
			OpenApi.Description,
			"Replace metadata with {meta}, creating missing ancestors, or set {archived:true|false}. Requires write. Archived subtrees remain readable. Success follows durable topic publication; Idempotency-Key preserves the first outcome.",
		),
	)
	.middleware(RequestValidation);
export const topicManagementHandlers = (api: typeof Api) =>
	HttpApiBuilder.group(api, "topicManagement", (handlers) =>
		handlers
			.handle("move", ({ payload, request }) =>
				failure(
					Effect.gen(function* () {
						const who = yield* identity("write");
						const path = yield* Effect.try({
							try: () =>
								decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice("/api/topics/".length)),
							catch: () => new KernelError({ code: "input_invalid" }),
						});
						if (!path.endsWith("/move")) return yield* new KernelError({ code: "input_invalid" });
						return yield* (yield* Messages).moveTopic(
							who,
							path.slice(0, -5),
							payload.to,
							(yield* Pages).move,
							request.headers["idempotency-key"],
						);
					}),
				),
			)
			.handle("meta", ({ payload, request }) =>
				failure(
					Effect.gen(function* () {
						const who = yield* identity("write");
						const path = yield* Effect.try({
							try: () =>
								decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice("/api/topics/".length)),
							catch: () => new KernelError({ code: "input_invalid" }),
						});
						return yield* (yield* Messages).topic(who, path, payload, request.headers["idempotency-key"]);
					}),
				),
			),
	).pipe(Layer.provide(bodyLayer(131072)));
