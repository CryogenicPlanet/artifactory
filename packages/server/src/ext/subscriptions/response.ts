import { Cause, Effect, Schema } from "effect";
import { refusal } from "../../conversation-request.ts";
import { errorSchema, errorSchemas } from "@comms/protocol/errors";
import { SubscriptionError } from "./contract.ts";

const policy = {
	input_invalid: { status: 400, hint: "Check /api and supply a valid webhook URL and subscription filter." },
	idempotency_conflict: {
		status: 409,
		hint: "Retry the original unchanged subscription request with its original Idempotency-Key. Use a new key only for a new subscription.",
	},
	subscription_limit: { status: 409, hint: "Remove an unused subscription before creating another." },
	subscription_not_found: {
		status: 404,
		hint: "Use an active subscription id owned by this instance, or a human session.",
	},
	subscription_unavailable: {
		status: 503,
		hint: "Retry the unchanged request with the same Idempotency-Key after publication recovers.",
	},
	webhook_response_too_large: { status: 503, hint: "Change the webhook receiver to return a response under 64 KiB." },
	event_cursor_invalid: {
		status: 503,
		hint: "Inspect the subscription event consumer and repair its cursor before retrying.",
	},
} as const satisfies Readonly<Record<SubscriptionError["code"], { readonly status: number; readonly hint: string }>>;
const ownErrors = Object.freeze(
	SubscriptionError.fields.code.literals.map((code) => errorSchema(code, policy[code].status)),
);
export const subscriptionErrors = Object.freeze([...errorSchemas, ...ownErrors]);

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
				const { status, hint } = policy[code];
				return yield* Effect.fail({
					error: { code, message: "Subscription request failed.", hint, retriable: status === 503 },
				});
			}),
		),
	);
