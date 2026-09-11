import { RequestValidation, layer as bodyLayer } from "./request-schema.ts";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./conversation.ts";
import { failure, identity } from "./conversation-request.ts";
import { MessagePatch } from "./kernel/message-operations.ts";
import { Message, Messages } from "./kernel/messages.ts";

const params = { ref: Schema.String };
const query = Schema.Record(Schema.String, Schema.Never);
export const messageGroup = HttpApiGroup.make("message")
	.add(
		HttpApiEndpoint.patch("update", "/api/messages/:ref", {
			params,
			query,
			payload: MessagePatch.annotate({ parseOptions: { onExcessProperty: "error" } }),
			success: Message,
		}).annotate(
			OpenApi.Description,
			"Edit body, tags or meta by m_ id or bare sequence. Requires write and the author's instance or a human. Success follows durable message.edited publication; Idempotency-Key preserves the first outcome.",
		),
		HttpApiEndpoint.delete("remove", "/api/messages/:ref", { params, query, success: Message }).annotate(
			OpenApi.Description,
			"Soft-delete by m_ id or bare sequence. Requires write and the author's instance or a human. Returns the tombstone after durable publication; Idempotency-Key preserves the first outcome.",
		),
	)
	.middleware(RequestValidation);
export const messageHandlers = (api: typeof Api) =>
	HttpApiBuilder.group(api, "message", (handlers) =>
		handlers
			.handle("update", ({ params, payload, request }) =>
				failure(
					Effect.gen(function* () {
						const who = yield* identity("write");
						return yield* (yield* Messages).update(who, params.ref, payload, request.headers["idempotency-key"]);
					}),
				),
			)
			.handle("remove", ({ params, request }) =>
				failure(
					Effect.gen(function* () {
						const who = yield* identity("write");
						return yield* (yield* Messages).remove(who, params.ref, request.headers["idempotency-key"]);
					}),
				),
			),
	).pipe(Layer.provide(bodyLayer(131072)));
