import { bootRoute, checkBootOrigin } from "./boot-route.ts";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth } from "./auth.ts";
import { assertionProof, authFailure, body, humanSession, pageHeaders, sessionResponse } from "./auth-http.ts";
import { authPage } from "./auth-page.ts";
import { PasskeyRegistrationResponse } from "./passkey-management-schema.ts";
import { PasskeyCodeParams, RemoveOrigin } from "./passkey-code-schema.ts";

/** Exact paths only. Redemption is public like /setup, carries the code or its bound challenge, and refuses bearer tokens. */
export const passkeyCodeRoute = (auth: Auth["Service"]) =>
	Effect.gen(function* () {
		const { request, url } = yield* bootRoute;
		const path = url.pathname;
		const method = request.method;
		const page = method === "GET" && path === "/auth/passkey-code";
		const create = method === "POST" && path === "/_boot/auth/passkey-code";
		const revoke = method === "DELETE" && path === "/_boot/auth/passkey-code";
		const redeemOptions = method === "POST" && path === "/_boot/auth/passkey-code/options";
		const redeemVerify = method === "POST" && path === "/_boot/auth/passkey-code/verify";
		const listOrigins = method === "GET" && path === "/_boot/auth/origins";
		const removeOrigin = method === "DELETE" && path === "/_boot/auth/origins";
		if (!page && !create && !revoke && !redeemOptions && !redeemVerify && !listOrigins && !removeOrigin) return null;
		return yield* authFailure(
			Effect.gen(function* () {
				if (page) return HttpServerResponse.text(authPage("code"), { contentType: "text/html", headers: pageHeaders });
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				if (redeemOptions || redeemVerify) {
					// Human-only: an agent credential never redeems a code, even alongside one.
					if (request.headers.authorization !== undefined) return yield* new AuthError({ code: "session_invalid" });
					// The service matches Origin exactly against allowed origins or the one origin the live code is bound to.
					if (redeemOptions) {
						const input = yield* body(Schema.Struct({ code: Schema.String }));
						return HttpServerResponse.jsonUnsafe(
							yield* auth.startPasskeyCodeRedemption(input.code, request.headers.origin),
						);
					}
					const input = yield* body(Schema.Struct({ id: Schema.String, response: PasskeyRegistrationResponse }));
					return sessionResponse(
						yield* auth.finishPasskeyCodeRedemption(input.id, input.response, request.headers.origin),
					);
				}
				yield* checkBootOrigin(listOrigins ? "passkeyRead" : "passkeyWrite", request, auth);
				const session = yield* humanSession(auth, request);
				if (listOrigins) return HttpServerResponse.jsonUnsafe(yield* auth.listOrigins(session.id));
				if (revoke) {
					yield* body(Schema.Struct({}));
					return HttpServerResponse.jsonUnsafe(yield* auth.revokePasskeyCode(session.id));
				}
				const proof = yield* assertionProof(request);
				if (create) {
					const input = yield* body(PasskeyCodeParams);
					return HttpServerResponse.jsonUnsafe(yield* auth.createPasskeyCode(input, proof, session.id));
				}
				const input = yield* body(RemoveOrigin);
				const party = yield* auth.relyingParty(request.headers.origin);
				return HttpServerResponse.jsonUnsafe(yield* auth.at(party).removeOrigin(input, proof, session.id));
			}).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store"))),
		);
	});
