import { errorSchemas } from "../../error-contract.ts";
import type { Api as ExtensionApi } from "../../kernel/extension-api.ts";
import { RequestValidation, layer as bodyLayer } from "../../request-schema.ts";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./api.ts";
import { refusal } from "../../conversation-request.ts";
import { MessagePatch, mutateMessage } from "./message-operations.ts";
import { Message } from "./messages.ts";

const params = { ref: Schema.String };
const query = Schema.Record(Schema.String, Schema.Never);
export const messageGroup = HttpApiGroup.make("message")
	.add(
		HttpApiEndpoint.patch("update", "/api/messages/:ref", {
			error: errorSchemas,
			params,
			query,
			payload: MessagePatch.annotate({ parseOptions: { onExcessProperty: "error" } }),
			success: Message,
		}).annotate(
			OpenApi.Description,
			"Edit body, tags or meta by m_ id or bare sequence. Requires write and the author's instance or a human. Success follows durable message.edited publication; Idempotency-Key preserves the first outcome.",
		),
		HttpApiEndpoint.delete("remove", "/api/messages/:ref", {
			error: errorSchemas,
			params,
			query,
			success: Message,
		}).annotate(
			OpenApi.Description,
			"Soft-delete by m_ id or bare sequence. Requires write and the author's instance or a human. Returns the tombstone after durable publication; Idempotency-Key preserves the first outcome.",
		),
	)
	.middleware(RequestValidation);
export const messageHandlers = (api: typeof Api, extension: ExtensionApi) =>
	HttpApiBuilder.group(api, "message", (handlers) =>
		handlers
			.handle("update", ({ params, payload, request }) =>
				refusal(
					Effect.gen(function* () {
						const ctx = yield* extension.context("write");
						return yield* mutateMessage(
							ctx.db,
							ctx.mutate,
							ctx,
							ctx,
							params.ref,
							payload,
							request.headers["idempotency-key"],
						);
					}),
				),
			)
			.handle("remove", ({ params, request }) =>
				refusal(
					Effect.gen(function* () {
						const ctx = yield* extension.context("write");
						return yield* mutateMessage(
							ctx.db,
							ctx.mutate,
							ctx,
							ctx,
							params.ref,
							null,
							request.headers["idempotency-key"],
						);
					}),
				),
			),
	).pipe(Layer.provide(bodyLayer(131072)));
