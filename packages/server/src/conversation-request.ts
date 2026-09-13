import { policy, encodeError, ErrorEnvelope, type ErrorDetail } from "@comms/protocol/errors";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { HttpApiSchemaError } from "effect/unstable/httpapi/HttpApiError";
import { Cause, Effect, Option, Schema } from "effect";
import { isHttpServerError, RequestParseError, RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { KernelError } from "./kernel/boot-channel.ts";
import { queryBoundHint } from "@comms/protocol/query-number";
import { requestDetail } from "./request-detail.ts";
import type { Identity } from "./kernel/identity.ts";
/** Recognize only failures caused by incoming wire data; response encoding remains a defect. */
export const requestErrorCode = (value: unknown): "input_invalid" | "query_invalid" | undefined => {
	if (HttpApiSchemaError.is(value) && ["Params", "Headers", "Query", "Payload"].includes(value.kind))
		return value.kind === "Query" ? "query_invalid" : "input_invalid";
	if (isHttpServerError(value) && value.reason instanceof RequestParseError) return "input_invalid";
	return undefined;
};
export const identity = (scope: string) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const h = request.headers;
		if (
			(h["x-chirp-auth-kind"] !== "human" && h["x-chirp-auth-kind"] !== "agent") ||
			!h["x-chirp-agent"] ||
			!h["x-chirp-instance"] ||
			!h["x-chirp-request-id"] ||
			!h["x-chirp-scopes"]?.split(",").includes(scope)
		)
			return yield* new KernelError({ code: "scope_required" });
		return {
			agent: h["x-chirp-agent"],
			instance: h["x-chirp-instance"],
			request: h["x-chirp-request-id"],
			label: h["x-chirp-label"] ?? "",
			kind: h["x-chirp-auth-kind"],
		} satisfies Identity;
	});
const normalize = <E>(cause: Cause.Cause<E>) =>
	Effect.gen(function* () {
		const request = Option.getOrUndefined(yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest));
		const route = request ? `${request.method} ${request.url.split("?")[0]}` : "the requested route";
		let code: KernelError["code"] | "store_unavailable" | "handler_failed" = "handler_failed";
		let named: ErrorDetail | undefined;
		if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
		const unexpected = cause.reasons.some((reason) => {
			if (reason._tag === "Interrupt") return false;
			const value = reason._tag === "Fail" ? reason.error : reason.defect;
			if (reason._tag === "Fail" && Schema.is(ErrorEnvelope)(value)) return false;
			if (requestErrorCode(value) !== undefined) return false;
			if (isHttpServerError(value) && value.reason instanceof RouteNotFound) return false;
			return reason._tag !== "Fail" || (!Schema.is(KernelError)(value) && !(isSqlError(value) && value.isRetryable));
		});
		for (const reason of unexpected ? [] : cause.reasons) {
			const value = reason._tag === "Fail" ? reason.error : reason._tag === "Die" ? reason.defect : undefined;
			if (isHttpServerError(value) && value.reason instanceof RouteNotFound) return null;
			if (reason._tag === "Fail" && Schema.is(ErrorEnvelope)(value)) return value;
			const invalid = requestErrorCode(value);
			if (invalid !== undefined) {
				code = invalid;
				// The declared bounds run here rather than in the middleware, which sees only encoded shapes.
				if (HttpApiSchemaError.is(value))
					named =
						invalid === "query_invalid"
							? requestDetail("query", value.cause.issue, queryBoundHint).detail
							: requestDetail("body", value.cause.issue).detail;
				break;
			}
			if (reason._tag === "Fail" && Schema.is(KernelError)(reason.error)) {
				code = reason.error.code;
				named = reason.error.detail;
				break;
			}
			if (reason._tag === "Fail" && isSqlError(reason.error) && reason.error.isRetryable) code = "store_unavailable";
		}
		const policyEntry =
			code === "handler_failed"
				? {
						status: 500,
						message: `Handler failed for ${route}.`,
						hint: "Inspect the server error log and fix or revert the edited route. This failure is not an unchanged-retry condition.",
					}
				: code === "store_unavailable"
					? {
							status: 503,
							message: "The app store is temporarily unavailable.",
							hint: "Retry the unchanged request with the same Idempotency-Key. If it persists, inspect authenticated /_boot/status.",
						}
					: policy[code];
		if (policyEntry.status === 500) yield* Effect.logError(cause).pipe(Effect.annotateLogs("route", route));
		return {
			error: {
				code,
				message: policyEntry.message,
				hint: named?.hint ?? policyEntry.hint,
				retriable: policyEntry.status === 503,
				...(named === undefined ? {} : { field: named.field }),
			},
		};
	});
/** HttpApi encodes these typed envelope failures using the endpoint's declared errors. */
export const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.catchCause((cause) =>
			normalize(cause).pipe(
				Effect.flatMap((body) =>
					body === null ? Effect.succeed(HttpServerResponse.empty({ status: 404 })) : Effect.fail(body),
				),
			),
		),
	);
/** Raw router boundaries use exactly the same envelope codec and status policy. */
export const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.catchCause((cause) =>
			normalize(cause).pipe(
				Effect.map((body) => {
					if (body === null) return HttpServerResponse.empty({ status: 404 });
					const code = body.error.code;
					const status = code === "handler_failed" ? 500 : code === "store_unavailable" ? 503 : policy[code].status;
					return HttpServerResponse.text(encodeError(body), {
						status,
						contentType: "application/json",
						headers: { "cache-control": "no-store" },
					});
				}),
			),
		),
	);
