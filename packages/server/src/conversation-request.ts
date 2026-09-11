import { HttpApiSchemaError } from "effect/unstable/httpapi/HttpApiError";
import { Effect, Schema } from "effect";
import { isHttpServerError, RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { KernelError } from "./kernel/boot-channel.ts";
import type { Identity } from "./kernel/messages.ts";
export const identity = (scope: string) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const h = request.headers;
		if (
			(h["x-comms-auth-kind"] !== "human" && h["x-comms-auth-kind"] !== "agent") ||
			!h["x-comms-agent"] ||
			!h["x-comms-instance"] ||
			!h["x-comms-request-id"] ||
			!h["x-comms-scopes"]?.split(",").includes(scope)
		)
			return yield* new KernelError({ code: "scope_required" });
		return {
			agent: h["x-comms-agent"],
			instance: h["x-comms-instance"],
			request: h["x-comms-request-id"],
			label: h["x-comms-label"] ?? "",
			kind: h["x-comms-auth-kind"],
		} satisfies Identity;
	});
export const failure = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
	effect.pipe(
		Effect.catchCause((cause) => {
			if (
				cause.reasons.some(
					(reason) =>
						reason._tag === "Fail" && isHttpServerError(reason.error) && reason.error.reason instanceof RouteNotFound,
				)
			)
				return Effect.succeed(HttpServerResponse.empty({ status: 404 }));
			const error = cause.reasons.find((reason) => reason._tag === "Fail" && Schema.is(KernelError)(reason.error));
			const invalidRequest = cause.reasons.some((reason) => {
				const value = reason._tag === "Fail" ? reason.error : reason._tag === "Die" ? reason.defect : undefined;
				return HttpApiSchemaError.is(value) && ["Params", "Headers", "Query", "Payload"].includes(value.kind);
			});
			const code = invalidRequest
				? "input_invalid"
				: error
					? "error" in error && Schema.is(KernelError)(error.error)
						? error.error.code
						: "request_invalid"
					: "store_unavailable";
			const status = ["scope_required", "author_required"].includes(code)
				? 403
				: ["topic_not_found", "message_not_found"].includes(code)
					? 404
					: ["idempotency_conflict", "topic_archived"].includes(code)
						? 409
						: ["input_invalid", "query_invalid"].includes(code)
							? 400
							: 503;
			return Effect.succeed(
				HttpServerResponse.jsonUnsafe(
					{
						error: {
							code,
							message: "Conversation request failed.",
							hint:
								status === 503
									? "Retry using the same Idempotency-Key; inspect authenticated boot status if failure persists."
									: "Check the documented request shape and required scope at /api.",
							retriable: status === 503,
						},
					},
					{ status },
				),
			);
		}),
	);
export const integer = (value: string | null, fallback: number, max: number) => {
	const n = value === null ? fallback : Number(value);
	return value === "" || !Number.isSafeInteger(n) || n < 0 || n > max ? null : n;
};
