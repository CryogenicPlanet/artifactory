import { bootRoute, checkBootOrigin } from "./boot-route.ts";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth } from "./auth.ts";
import { assertionProof, authFailure, body, humanSession } from "./auth-http.ts";

/** Signal boot only after the finite response reaches the HTTP adapter. The external supervisor restarts it. */
export const restartRoute = (auth: Auth["Service"], restart: Effect.Effect<void>) =>
	Effect.gen(function* () {
		const { request, url } = yield* bootRoute;
		if (url.pathname !== "/_boot/restart") return null;
		return yield* authFailure(
			Effect.gen(function* () {
				const session = yield* humanSession(auth, request);
				if (request.method !== "POST")
					return HttpServerResponse.empty({ status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
				yield* checkBootOrigin("restart", request, auth);
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				yield* body(Schema.Record(Schema.String, Schema.Never));
				const proof = yield* assertionProof(request);
				yield* auth
					.authorizeRestart(proof, session.id)
					.pipe(Effect.andThen(Effect.addFinalizer(() => restart)), Effect.uninterruptible);
				return HttpServerResponse.jsonUnsafe(
					{ status: "restarting" },
					{
						status: 202,
						headers: { "cache-control": "no-store" },
					},
				);
			}),
		);
	});
