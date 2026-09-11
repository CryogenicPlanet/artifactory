import { Effect, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type AuthConfig } from "./auth.ts";
import { assertionProof, humanSession, authFailure, authErrorResponse, body, type AuthStore } from "./auth-http.ts";
import { PasskeyRegistrationResponse } from "./passkey-management-schema.ts";

export const passkeyManagementRoute = (store: AuthStore, config: AuthConfig) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		const path = url.pathname;
		const list = request.method === "GET" && path === "/_boot/auth/passkeys";
		const start = request.method === "POST" && path === "/_boot/auth/passkeys/options";
		const finish = request.method === "POST" && path === "/_boot/auth/passkeys/verify";
		const remove =
			request.method === "DELETE" ? /^\/_boot\/auth\/passkeys\/([A-Za-z0-9_-]{1,2048})$/.exec(path)?.[1] : undefined;
		if (!list && !start && !finish && !remove) return null;
		return yield* authFailure(
			Effect.gen(function* () {
				const auth = yield* Ref.get(store);
				if (!auth) return authErrorResponse("boot_unavailable", 503);
				if (!list && request.headers.origin !== config.expectedOrigin)
					return yield* new AuthError({ code: "origin_invalid" });
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				const session = yield* humanSession(auth, request);
				if (list) return HttpServerResponse.jsonUnsafe(yield* auth.listPasskeys(session.id));
				if (start) {
					const input = yield* body(Schema.Struct({ label: Schema.String }));
					return HttpServerResponse.jsonUnsafe(yield* auth.startPasskeyRegistration(input.label, session.id));
				}
				if (finish) {
					const input = yield* body(
						Schema.Struct({ id: Schema.String, label: Schema.String, response: PasskeyRegistrationResponse }),
					);
					const proof = yield* assertionProof(request);
					return HttpServerResponse.jsonUnsafe(
						yield* auth.finishPasskeyRegistration(
							{ registration: input.id, label: input.label, response: input.response },
							proof,
							session.id,
						),
					);
				}
				if (remove) {
					yield* body(Schema.Struct({}));
					const proof = yield* assertionProof(request);
					return HttpServerResponse.jsonUnsafe(yield* auth.deletePasskey({ id: remove }, proof, session.id));
				}
				return HttpServerResponse.empty({ status: 404 });
			}).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store"))),
		);
	});
