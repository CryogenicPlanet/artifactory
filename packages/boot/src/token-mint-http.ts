import { Effect, Ref } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type AuthConfig } from "./auth.ts";
import {
	assertionProof,
	authErrorResponse,
	authFailure,
	body,
	humanSession,
	sessionToken,
	type AuthStore,
} from "./auth-http.ts";
import { MintToken } from "./token-mint-schema.ts";

export const tokenMintRoute = (store: AuthStore, config: AuthConfig) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		if (request.method !== "POST" || !["/_boot/tokens", "/api/tokens"].includes(url.pathname)) return null;
		return yield* authFailure(
			Effect.gen(function* () {
				const auth = yield* Ref.get(store);
				if (!auth) return authErrorResponse("boot_unavailable", 503);
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				if (request.headers.origin !== config.expectedOrigin) return yield* new AuthError({ code: "origin_invalid" });
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
