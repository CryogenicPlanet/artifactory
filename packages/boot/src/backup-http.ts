import { Effect, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError } from "./auth.ts";
import { authErrorResponse, authFailure, humanSession, type AuthStore } from "./auth-http.ts";
import { BackupCursor, type BackupInventory } from "./backup-inventory.ts";

export type BackupStore = Ref.Ref<BackupInventory | null>;

/** GET /_boot/db/backups lists retained catalog metadata for a live human session, even without an app. */
export const backupRoute = (authStore: AuthStore, backupStore: BackupStore) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		if (request.method !== "GET" || url.pathname !== "/_boot/db/backups") return null;
		return yield* authFailure(
			Effect.gen(function* () {
				const auth = yield* Ref.get(authStore);
				if (!auth) return authErrorResponse("boot_unavailable", 503);
				const session = yield* humanSession(auth, request);
				const list = yield* Ref.get(backupStore);
				if (!list) return authErrorResponse("boot_unavailable", 503);
				const params = url.searchParams;
				if ([...params.keys()].some((key) => !["limit", "before"].includes(key) || params.getAll(key).length !== 1))
					return yield* new AuthError({ code: "invalid_request" });
				const rawLimit = params.get("limit") ?? "100";
				const limit = Number(rawLimit);
				if (!/^\d{1,3}$/.test(rawLimit) || limit < 1 || limit > 200)
					return yield* new AuthError({ code: "invalid_request" });
				const rawBefore = params.get("before");
				const before = yield* Effect.gen(function* () {
					if (rawBefore === null) return null;
					if (!/^[A-Za-z0-9_-]{1,512}$/.test(rawBefore)) return yield* new AuthError({ code: "invalid_request" });
					const bytes = Buffer.from(rawBefore, "base64url");
					if (bytes.toString("base64url") !== rawBefore) return yield* new AuthError({ code: "invalid_request" });
					const cursor = yield* Schema.decodeEffect(Schema.fromJsonString(BackupCursor))(bytes.toString("utf8"), {
						onExcessProperty: "error",
					});
					if (
						!Number.isSafeInteger(cursor.taken_at) ||
						cursor.taken_at < 0 ||
						cursor.id.length < 1 ||
						cursor.id.length > 128
					)
						return yield* new AuthError({ code: "invalid_request" });
					return cursor;
				}).pipe(Effect.mapError(() => new AuthError({ code: "invalid_request" })));
				return HttpServerResponse.jsonUnsafe(yield* list({ limit, before }), {
					headers: {
						"cache-control": "no-store",
						"x-content-type-options": "nosniff",
						"x-comms-token-expires": String(session.expiresAt),
					},
				});
			}),
		).pipe(Effect.map(HttpServerResponse.setHeader("x-content-type-options", "nosniff")));
	});
