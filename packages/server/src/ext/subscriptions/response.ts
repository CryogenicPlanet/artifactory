import { Cause, Effect, Schema } from "effect";
import { refusal } from "../../conversation-request.ts";
import { errorSchema, errorSchemas, policy as sharedPolicy } from "@comms/protocol/errors";
import type { KernelErrorCode } from "@comms/protocol/error-code";
import { SubscriptionError } from "./contract.ts";

const policy = {
	input_invalid: sharedPolicy.input_invalid,
	idempotency_conflict: sharedPolicy.idempotency_conflict,
	event_cursor_invalid: sharedPolicy.event_cursor_invalid,
	subscription_limit: { status: 409, hint: "Remove an unused subscription before creating another." },
	subscription_not_found: {
		status: 404,
		hint: "Use an active subscription id owned by this instance, or a human session.",
	},
	subscription_unavailable: {
		status: 503,
		hint: "Retry the unchanged request with the same Idempotency-Key after publication recovers.",
	},
	webhook_response_too_large: { status: 500, hint: "Change the webhook receiver to return a response under 64 KiB." },
} as const satisfies Readonly<Record<SubscriptionError["code"], { readonly status: number; readonly hint: string }>>;
const ownCodes = SubscriptionError.fields.code.literals.filter(
	(code) => code !== "input_invalid" && code !== "idempotency_conflict" && code !== "event_cursor_invalid",
) satisfies ReadonlyArray<Exclude<SubscriptionError["code"], typeof KernelErrorCode.Type>>;
const ownErrors = Object.freeze(ownCodes.map((code) => errorSchema(code, policy[code].status)));
export const subscriptionErrors = Object.freeze([...errorSchemas, ...ownErrors]);

const envelope = <Code extends SubscriptionError["code"]>(code: Code) => ({
	error: {
		code,
		message: "Subscription request failed.",
		hint: policy[code].hint,
		retriable: policy[code].status === 503,
	},
});

export const respond = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.catchCause((cause) =>
			Effect.gen(function* () {
				if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
				// A typed refusal cannot hide an unknown failure or a finalizer defect.
				if (
					cause.reasons.some(
						(reason) =>
							reason._tag !== "Interrupt" && (reason._tag !== "Fail" || !Schema.is(SubscriptionError)(reason.error)),
					)
				)
					return yield* refusal(Effect.failCause(cause));
				const own = cause.reasons.find(
					(reason) => reason._tag === "Fail" && Schema.is(SubscriptionError)(reason.error),
				);
				if (own?._tag !== "Fail" || !Schema.is(SubscriptionError)(own.error))
					return yield* refusal(Effect.failCause(cause));
				const { code } = own.error;
				// Keep shared and extension envelopes distinct in the declared HTTP error union.
				if (code === "input_invalid" || code === "idempotency_conflict" || code === "event_cursor_invalid")
					return yield* Effect.fail(envelope(code));
				return yield* Effect.fail(envelope(code));
			}),
		),
	);
