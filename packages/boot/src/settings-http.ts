import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { type Auth, type AuthConfig, AuthError } from "./auth.ts";
import { assertionProof, authFailure, body, humanSession } from "./auth-http.ts";
import { SettingsChange } from "./settings-schema.ts";

export const settingsRoute = (auth: Auth["Service"], config: AuthConfig) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		if (url.pathname !== "/_boot/settings") return null;
		return yield* authFailure(
			Effect.gen(function* () {
				yield* humanSession(auth, request);
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				if (request.method === "GET") return HttpServerResponse.jsonUnsafe(yield* auth.settings);
				if (request.method !== "POST")
					return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, POST" } });
				if (request.headers.origin !== config.expectedOrigin) return yield* new AuthError({ code: "origin_invalid" });
				const params = yield* body(SettingsChange);
				const proof = yield* assertionProof(request);
				const session = yield* humanSession(auth, request);
				return HttpServerResponse.jsonUnsafe(yield* auth.changeSettings(params, proof, session.id));
			}).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store"))),
		);
	});
