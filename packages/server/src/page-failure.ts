import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { errorSchema } from "@comms/protocol/errors";
import { PageRejected } from "./ext/core/pages.ts";
import { failure } from "./conversation-request.ts";

const policy = {
	page_not_found: { status: 404, hint: "Check that the page exists under /p/ and has not been deleted." },
	page_path_invalid: { status: 400, hint: "Use a valid page path under /p/ without traversal or symlinks." },
	pages_unavailable: {
		status: 503,
		hint: "The page store or publication state is unavailable. Retry the unchanged read; if it persists, inspect authenticated /_boot/status.",
	},
	pages_move_pending: {
		status: 503,
		hint: "This page tree is moving. Finish the original topic move with its original Idempotency-Key if one was supplied; other topics remain available.",
	},
} as const satisfies Readonly<Record<PageRejected["code"], { readonly status: number; readonly hint: string }>>;

/** Classify the whole cause before preserving a page refusal: a mixed defect must
 * never be hidden by a retriable page error. Common failures retain their codec. */
export const pageFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.catchCause((cause) => {
			const known = cause.reasons.every(
				(reason) => reason._tag === "Interrupt" || (reason._tag === "Fail" && Schema.is(PageRejected)(reason.error)),
			);
			if (known) {
				for (const reason of cause.reasons) {
					if (reason._tag !== "Fail" || !Schema.is(PageRejected)(reason.error)) continue;
					const code = reason.error.code;
					const { status, hint } = policy[code];
					const body = { error: { code, message: "Page request failed.", hint, retriable: status === 503 } };
					return HttpServerResponse.schemaJson(errorSchema(code, status))(body, {
						status,
						headers: { "cache-control": "no-store" },
					}).pipe(failure);
				}
			}
			return failure(Effect.failCause(cause));
		}),
	);
