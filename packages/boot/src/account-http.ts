import { bootRoute } from "./boot-route.ts";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth } from "./auth.ts";
import { authFailure, humanSession } from "./auth-http.ts";

/** Human-only account metadata, available without a healthy app or a fresh assertion. */
export const accountRoute = (auth: Auth["Service"]) =>
	Effect.gen(function* () {
		const { request, url } = yield* bootRoute;
		const enrollments = url.pathname === "/_boot/enrollments";
		if (request.method !== "GET" || (!enrollments && url.pathname !== "/_boot/tokens")) return null;
		return yield* authFailure(
			Effect.gen(function* () {
				yield* humanSession(auth, request);
				if (url.searchParams.size > 0) return yield* new AuthError({ code: "invalid_request" });
				const result = enrollments ? yield* auth.listEnrollments() : yield* auth.listTokenFamilies();
				return HttpServerResponse.jsonUnsafe(result, {
					headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
				});
			}),
		);
	});
