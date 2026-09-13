import { RequestValidation } from "@comms/protocol/request-validation";
import { Effect, Layer, Schema, Stream } from "effect";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { refusal } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { requestDetail } from "./request-detail.ts";

/** Bound bytes and read time before a declared HttpApi payload is decoded. */
export const boundedRequest = (maximum: number) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		let bytes = 0;
		const chunks = yield* request.stream.pipe(
			Stream.tap((chunk) => {
				bytes += chunk.byteLength;
				return bytes > maximum ? Effect.fail(new KernelError({ code: "input_invalid" })) : Effect.void;
			}),
			Stream.runCollect,
			Effect.timeout("5 seconds"),
			Effect.mapError(() => new KernelError({ code: "input_invalid" })),
		);
		const bounded = HttpServerRequest.fromWeb(
			new Request(new URL(request.url, "http://localhost"), {
				method: request.method,
				headers: request.headers,
				body: Buffer.concat(chunks),
			}),
		).modify({ url: request.url, remoteAddress: request.remoteAddress });

		return bounded;
	});

export const layer = (maximum: number) =>
	Layer.succeed(RequestValidation)((handler, { endpoint }) =>
		refusal(
			Effect.gen(function* () {
				yield* HttpEffect.appendPreResponseHandler((_request, response) =>
					Effect.succeed(
						response.status >= 400 ? HttpServerResponse.setHeader(response, "cache-control", "no-store") : response,
					),
				);
				const request = yield* HttpServerRequest.HttpServerRequest;
				const query = yield* HttpServerRequest.ParsedSearchParams;
				yield* Schema.decodeEffect(Schema.toEncoded(endpoint.query ?? Schema.Record(Schema.String, Schema.Never)), {
					onExcessProperty: "error",
				})(query).pipe(
					Effect.mapError(
						(error) => new KernelError({ code: "query_invalid", ...requestDetail("query", error.issue) }),
					),
				);
				if (request.method === "GET" || request.method === "HEAD" || endpoint.payload.size === 0) return yield* handler;
				const bounded = yield* boundedRequest(maximum);
				const contentType =
					(request.headers["content-type"] ?? "application/json").split(";")[0]?.trim().toLowerCase() ?? "";
				const payload = endpoint.payload.get(contentType);
				if (!payload) return yield* new KernelError({ code: "unsupported_media_type" });
				if (payload.encoding._tag === "Json") {
					const json = yield* bounded.json;
					yield* Schema.decodeEffect(Schema.toEncoded(Schema.Union(payload.schemas)), {
						onExcessProperty: "error",
					})(json).pipe(
						Effect.mapError(
							(error) => new KernelError({ code: "input_invalid", ...requestDetail("body", error.issue) }),
						),
					);
				}
				return yield* handler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, bounded));
			}),
		),
	);
