import { bootRoute } from "./boot-route.ts";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { type Auth, AuthError } from "./auth.ts";
import { authFailure, humanSession } from "./auth-http.ts";
import { recoveryPage } from "./recovery-page.ts";

/** Human recovery stays reachable without the editable app or any of its assets. */
export const recoveryRoute = (auth: Auth["Service"]) =>
	Effect.gen(function* () {
		const { request, url } = yield* bootRoute;
		if (url.pathname !== "/_boot/recovery") return null;
		return yield* authFailure(
			Effect.gen(function* () {
				yield* humanSession(auth, request);
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				if (request.method !== "GET")
					return HttpServerResponse.empty({ status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
				return HttpServerResponse.text(recoveryPage, {
					contentType: "text/html; charset=utf-8",
					headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
				});
			}),
		);
	});
