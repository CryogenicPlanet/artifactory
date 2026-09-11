import { HttpApiSchemaError } from "effect/unstable/httpapi/HttpApiError";
import { Effect, Schema } from "effect";
import { isHttpServerError, RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { KernelError } from "./kernel/boot-channel.ts";
import type { Identity } from "./kernel/messages.ts";
const requestHint = (code: string) => {
	switch (code) {
		case "scope_required":
			return "Use credentials granted the required scope. Agents need a human-approved enrollment: read for reading/listening, write for conversation changes.";
		case "author_required":
			return "Use the original authoring instance's credentials or a human session. Another instance of the same agent is a different author.";
		case "topic_not_found":
			return "Check the topic path with GET /api/topics. Deleted topics remain unavailable.";
		case "message_not_found":
			return "Use the message id returned by a message read. Deleted messages remain unavailable.";
		case "idempotency_conflict":
			return "Retry the original unchanged request with its original Idempotency-Key. Use a new key only for an intentionally new operation.";
		case "topic_exists":
			return "Choose a destination whose topic subtree and page directory do not already exist.";
		case "topic_archived":
			return "Unarchive the topic and its archived ancestors before changing it.";
		case "input_invalid":
			return "Check the JSON fields and size limits at /api. Topic segments use lowercase letters, numbers, dot, underscore or hyphen, joined by /; only the first may start with @.";
		case "query_invalid":
			return "Check query parameters at /api. Use a nonnegative integer since from a returned cursor, and include each parameter only once.";
		default:
			return "Retry using the same Idempotency-Key; inspect authenticated boot status if failure persists.";
	}
};
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
					: ["idempotency_conflict", "topic_archived", "topic_exists"].includes(code)
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
							hint: requestHint(code),
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
