import { bootRoute, checkBootOrigin } from "./boot-route.ts";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth, type AuthConfig } from "./auth.ts";
import { assertionProof, authFailure, body, humanSession, sessionToken } from "./auth-http.ts";
import { MintToken } from "./token-mint-schema.ts";

export const tokenMintRoute = (auth: Auth["Service"], config: AuthConfig) =>
	Effect.gen(function* () {
		const { request, url } = yield* bootRoute;
		if (request.method !== "POST" || !["/_boot/tokens", "/api/tokens"].includes(url.pathname)) return null;
		return yield* authFailure(
			Effect.gen(function* () {
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				yield* checkBootOrigin("tokenMint", request, config);
				const session = yield* humanSession(auth, request);
				const secret = sessionToken(request);
				if (!secret) return yield* new AuthError({ code: "session_invalid" });
				const input = yield* body(MintToken);
				const key = request.headers["idempotency-key"];
				const params = key === undefined ? input : { ...input, idempotency_key: key };
				const pair = yield* auth.mintTokens(params, yield* assertionProof(request), session.id, secret);
				return HttpServerResponse.jsonUnsafe(pair, {
					headers: { "cache-control": "no-store", "x-comms-token-expires": String(session.expiresAt) },
				});
			}),
		);
	});
