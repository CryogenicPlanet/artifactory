import { Effect, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./conversation.ts";
import { failure, identity } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { MessagePatch } from "./kernel/message-operations.ts";
import { Message, Messages } from "./kernel/messages.ts";

export const messageGroup = HttpApiGroup.make("message").add(
	HttpApiEndpoint.get("get", "/api/messages/:id", { params: { id: Schema.String }, success: Message }).annotate(
		OpenApi.Description,
		"Read one published message by ID. Requires read; deleted messages return404.",
	),
	HttpApiEndpoint.patch("update", "/api/messages/:id", {
		params: { id: Schema.String },
		payload: MessagePatch,
		success: Message,
	}).annotate(
		OpenApi.Description,
		"Replace supplied body, tags or meta fields. Requires write and the author's instance or a human. Attribution and creation sequence remain unchanged. Success follows durable message.edited publication; optional Idempotency-Key preserves the first outcome.",
	),
	HttpApiEndpoint.delete("remove", "/api/messages/:id", { params: { id: Schema.String }, success: Message }).annotate(
		OpenApi.Description,
		"Soft-delete a message. Requires write and the author's instance or a human. Returns the tombstone after durable message.deleted publication. Repeated deletion is harmless; optional Idempotency-Key preserves the first outcome.",
	),
);
export const messageHandlers = (api: typeof Api) =>
	HttpApiBuilder.group(api, "message", (handlers) =>
		handlers
			.handleRaw("get", ({ params }) =>
				failure(
					Effect.gen(function* () {
						yield* identity("read");
						return HttpServerResponse.jsonUnsafe(yield* (yield* Messages).get(params.id));
					}),
				),
			)
			.handleRaw("update", ({ params }) =>
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
						const input = yield* Schema.decodeEffect(Schema.fromJsonString(MessagePatch))(
							Buffer.concat(chunks).toString("utf8"),
							{ onExcessProperty: "error" },
						).pipe(Effect.mapError(() => new KernelError({ code: "input_invalid" })));
						return HttpServerResponse.jsonUnsafe(
							yield* (yield* Messages).update(who, params.id, input, request.headers["idempotency-key"]),
						);
					}),
				),
			)
			.handleRaw("remove", ({ params }) =>
				failure(
					Effect.gen(function* () {
						const who = yield* identity("write");
						const request = yield* HttpServerRequest.HttpServerRequest;
						return HttpServerResponse.jsonUnsafe(
							yield* (yield* Messages).remove(who, params.id, request.headers["idempotency-key"]),
						);
					}),
				),
			),
	);
