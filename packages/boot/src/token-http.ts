import { Effect, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type AuthConfig } from "./auth.ts";
import { assertionProof, authErrorResponse, authFailure, body, humanSession, type AuthStore } from "./auth-http.ts";

/** These exact routes survive child failure; refresh proves itself, revoke always requires the human. */
export const tokenRoute = (store: AuthStore, config: AuthConfig) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		const refresh = request.method === "POST" && ["/auth/refresh", "/_boot/refresh"].includes(url.pathname);
		const family =
			request.method === "POST"
				? /^\/(?:_boot|api)\/tokens\/(f_[A-Za-z0-9_-]{43})\/revoke$/.exec(url.pathname)?.[1]
				: undefined;
		if (!refresh && !family) return null;
		return yield* authFailure(
			Effect.gen(function* () {
				const auth = yield* Ref.get(store);
				if (!auth) return authErrorResponse("boot_unavailable", 503);
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				if (refresh) {
					const input = yield* body(Schema.Struct({ refresh: Schema.String }));
					const pair = yield* auth.refreshTokens(input.refresh, request.headers["idempotency-key"]);
					return HttpServerResponse.jsonUnsafe(pair, { headers: { "x-comms-token-expires": String(pair.expires_at) } });
				}
				if (request.headers.origin !== config.expectedOrigin) return yield* new AuthError({ code: "origin_invalid" });
				const session = yield* humanSession(auth, request);
				yield* body(Schema.Struct({}));
				if (!family) return yield* new AuthError({ code: "invalid_request" });
				return HttpServerResponse.jsonUnsafe(
					yield* auth.revokeFamily({ family }, yield* assertionProof(request), session.id),
					{
						headers: { "x-comms-token-expires": String(session.expiresAt) },
					},
				);
			}).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store"))),
		);
	});
