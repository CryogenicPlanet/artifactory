import { Effect, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnrollmentStatus } from "./account-queries.ts";
import { AuthError } from "./auth.ts";
import { authErrorResponse, authFailure, humanSession, type AuthStore } from "./auth-http.ts";

/** Human-only account metadata, available without a healthy app or a fresh assertion. */
export const accountRoute = (store: AuthStore) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		const enrollments = url.pathname === "/_boot/enrollments";
		if (request.method !== "GET" || (!enrollments && url.pathname !== "/_boot/tokens")) return null;
		return yield* authFailure(
			Effect.gen(function* () {
				const auth = yield* Ref.get(store);
				if (!auth) return authErrorResponse("boot_unavailable", 503);
				yield* humanSession(auth, request);
				const params = url.searchParams;
				const allowed = enrollments ? ["status", "limit", "before"] : ["limit", "before"];
				if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1))
					return yield* new AuthError({ code: "invalid_request" });
				const rawLimit = params.get("limit") ?? "100";
				const limit = Number(rawLimit);
				const before = params.get("before");
				const status = params.get("status");
				if (
					!/^\d{1,3}$/.test(rawLimit) ||
					limit < 1 ||
					limit > 200 ||
					(before !== null && !(enrollments ? /^e_[A-Za-z0-9_-]{43}$/ : /^f_[A-Za-z0-9_-]{43}$/).test(before)) ||
					(status !== null && !Schema.is(EnrollmentStatus)(status))
				)
					return yield* new AuthError({ code: "invalid_request" });
				const result = enrollments
					? yield* auth.listEnrollments({ limit, before, status })
					: yield* auth.listTokenFamilies({ limit, before });
				return HttpServerResponse.jsonUnsafe(result, {
					headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
				});
			}),
		);
	});
