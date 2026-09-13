import { RemoteDatabaseError } from "./remote-db-ops.ts";
import { bootRoute, checkBootOrigin } from "./boot-route.ts";
import { isAppStoreIdentityError, appIdentityPolicy, transferPolicy } from "./app-store-identity.ts";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth, type AuthConfig } from "./auth.ts";
import { SourceRejected } from "./source-schema.ts";
import { assertionProof, authErrorResponse, authFailure, body, humanSession } from "./auth-http.ts";
import type { AssertionProof } from "./enrollment.ts";
import { databaseRestoreParams, type RestoreSelection } from "./database-restore-schema.ts";
import type { DatabaseRestore } from "./database-restore.ts";

const Selector = Schema.Union([Schema.Struct({ backup: Schema.String }), Schema.Struct({ id: Schema.String })]);

/** Human-only database rollback remains available through the immutable listener. */
export const databaseRestoreRoute = (restore: DatabaseRestore, auth: Auth["Service"], config: AuthConfig) =>
	Effect.gen(function* () {
		const { request, url } = yield* bootRoute;
		if (url.pathname !== "/_boot/db/restore") return null;
		return yield* authFailure(
			Effect.gen(function* () {
				const session = yield* humanSession(auth, request);
				if (request.method !== "POST")
					return HttpServerResponse.empty({ status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
				yield* checkBootOrigin("databaseRestore", request, config);
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				const input = yield* body(Selector);
				const key = request.headers["idempotency-key"];
				const params = { ...databaseRestoreParams(input), ...(key !== undefined ? { idempotency_key: key } : {}) };
				const proof = yield* assertionProof(request);
				return yield* databaseRestoreResponse(restore, params, proof, session.id);
			}),
		);
	});

export const databaseRestoreResponse = (
	restore: DatabaseRestore,
	params: RestoreSelection,
	proof: AssertionProof,
	sessionId: string,
) =>
	authFailure(
		restore.restore(params, proof, sessionId).pipe(
			Effect.map((result) =>
				HttpServerResponse.jsonUnsafe(result, {
					status: result.status === "restored" ? 200 : 409,
					headers: { "cache-control": "no-store" },
				}),
			),
			Effect.catchCause((cause) => {
				const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined;
				if (reason?._tag !== "Fail") return Effect.failCause(cause);
				const error = reason.error;
				if (Schema.is(RemoteDatabaseError)(error))
					return Effect.succeed(
						HttpServerResponse.jsonUnsafe(
							{
								error: { code: error.code, message: error.message, hint: error.message, retriable: false },
							},
							{ status: 409, headers: { "cache-control": "no-store" } },
						),
					);
				if (isAppStoreIdentityError(error))
					return Effect.succeed(
						HttpServerResponse.jsonUnsafe(
							{
								error: {
									code: error.code,
									message: "App store identity could not be verified.",
									hint:
										error.code === "store_transferred" || error.code === "store_transfer_incomplete"
											? transferPolicy[error.code].hint
											: appIdentityPolicy.hint,
									retriable: false,
								},
							},
							{ status: 409, headers: { "cache-control": "no-store" } },
						),
					);
				if (Schema.is(SourceRejected)(error) && error.code === "external_conflict")
					return Effect.succeed(
						HttpServerResponse.jsonUnsafe(
							{
								error: {
									code: "external_conflict",
									message: "Restore source publication is blocked by conflicting source.",
									hint: "Preserve the pending source journal and accepted data. Repair the conflicting source bytes, then retry the original restore.",
									retriable: false,
								},
							},
							{ status: 409, headers: { "cache-control": "no-store" } },
						),
					);
				if (Schema.is(AuthError)(error)) {
					if (["backup_not_found", "generation_not_found"].includes(error.code))
						return Effect.succeed(authErrorResponse(error.code, 404));
					if (["backup_not_restorable", "generation_not_restorable", "restore_in_progress"].includes(error.code))
						return Effect.succeed(authErrorResponse(error.code, 409));
				}
				return Effect.failCause(cause);
			}),
		),
	);
