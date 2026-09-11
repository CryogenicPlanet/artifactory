import { Effect, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./conversation.ts";
import { failure, identity } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { Messages } from "./kernel/messages.ts";
import { ReactionInput, ReactionList, ReactionResult } from "./kernel/reaction-operations.ts";

export const reactionGroup = HttpApiGroup.make("reactions").add(
	HttpApiEndpoint.post("toggle", "/api/reactions", { payload: ReactionInput, success: ReactionResult }).annotate(
		OpenApi.Description,
		"Toggle one emoji for the authenticated instance on a message. Requires write; deleted messages and archived ancestors refuse new toggles. Success follows event publication. Supply Idempotency-Key to retry without toggling twice; keys are scoped to the reaction endpoint and instance.",
	),
	HttpApiEndpoint.get("list", "/api/reactions", { query: { message: Schema.String }, success: ReactionList }).annotate(
		OpenApi.Description,
		"List published active reactions for one message, ordered by emoji and instance. Requires read; deleted messages return404.",
	),
);
export const reactionHandlers = (api: typeof Api) =>
	HttpApiBuilder.group(api, "reactions", (handlers) =>
		handlers
			.handleRaw("toggle", () =>
				failure(
					Effect.gen(function* () {
						const who = yield* identity("write");
						const request = yield* HttpServerRequest.HttpServerRequest;
						let bytes = 0;
						const chunks = yield* request.stream.pipe(
							Stream.tap((chunk) =>
								Effect.gen(function* () {
									bytes += chunk.byteLength;
									if (bytes > 4096) return yield* new KernelError({ code: "input_invalid" });
								}),
							),
							Stream.runCollect,
							Effect.timeout("5 seconds"),
						);
						const input = yield* Schema.decodeEffect(Schema.fromJsonString(ReactionInput))(
							Buffer.concat(chunks).toString("utf8"),
							{ onExcessProperty: "error" },
						).pipe(Effect.mapError(() => new KernelError({ code: "input_invalid" })));
						return HttpServerResponse.jsonUnsafe(
							yield* (yield* Messages).toggleReaction(who, input, request.headers["idempotency-key"]),
						);
					}),
				),
			)
			.handleRaw("list", () =>
				failure(
					Effect.gen(function* () {
						yield* identity("read");
						const request = yield* HttpServerRequest.HttpServerRequest;
						const params = new URL(request.url, "http://localhost").searchParams;
						const message = params.get("message");
						if (
							message === null ||
							[...params.keys()].some((key) => key !== "message") ||
							params.getAll("message").length !== 1
						)
							return yield* new KernelError({ code: "query_invalid" });
						return HttpServerResponse.jsonUnsafe(yield* (yield* Messages).reactions(message));
					}),
				),
			),
	);
