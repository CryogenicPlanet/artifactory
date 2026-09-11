import { Effect, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type AuthConfig } from "./auth.ts";
import { assertionProof, authErrorResponse, authFailure, body, humanSession, type AuthStore } from "./auth-http.ts";
import { databaseRestoreParams } from "./database-restore-schema.ts";
import type { DatabaseRestore } from "./database-restore.ts";

const Selector = Schema.Union([Schema.Struct({ backup: Schema.String }), Schema.Struct({ id: Schema.String })]);
export type DatabaseRestoreStore = Ref.Ref<DatabaseRestore | null>;

/** Human-only database rollback remains available through the immutable listener. */
export const databaseRestoreRoute = (store: DatabaseRestoreStore, authStore: AuthStore, config: AuthConfig) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		if (url.pathname !== "/_boot/db/restore") return null;
		return yield* authFailure(
			Effect.gen(function* () {
				const auth = yield* Ref.get(authStore);
				if (!auth) return authErrorResponse("boot_unavailable", 503);
				const session = yield* humanSession(auth, request);
				if (request.method !== "POST")
					return HttpServerResponse.empty({ status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
				if (request.headers.origin !== config.expectedOrigin) return yield* new AuthError({ code: "origin_invalid" });
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				const input = yield* body(Selector);
				const key = request.headers["idempotency-key"];
				const params = { ...databaseRestoreParams(input), ...(key !== undefined ? { idempotency_key: key } : {}) };
				const proof = yield* assertionProof(request);
				const restore = yield* Ref.get(store);
				if (!restore) return authErrorResponse("boot_unavailable", 503);
				return yield* restore.restore(params, proof, session.id).pipe(
					Effect.map((result) =>
						HttpServerResponse.jsonUnsafe(result, {
							status: result.status === "restored" ? 200 : 409,
							headers: { "cache-control": "no-store" },
						}),
					),
					Effect.catchIf(Schema.is(AuthError), (error) =>
						["backup_not_found", "backup_not_restorable", "restore_in_progress"].includes(error.code)
							? Effect.succeed(authErrorResponse(error.code, error.code === "backup_not_found" ? 404 : 409))
							: Effect.fail(error),
					),
				);
			}),
		);
	});
