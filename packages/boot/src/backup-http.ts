import { Cause, Effect, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type AuthConfig } from "./auth.ts";
import { authErrorResponse, authFailure, authenticate, body, humanSession, type AuthStore } from "./auth-http.ts";
import type { DatabaseBackup } from "./database-backup.ts";
import { StorageRejected } from "./storage-headroom.ts";
import { ArtifactRetentionRejected } from "./artifact-retention.ts";
import { BackupCursor, type BackupInventory } from "./backup-inventory.ts";

export type BackupStore = Ref.Ref<BackupInventory | null>;
export type BackupCaptureStore = Ref.Ref<DatabaseBackup | null>;

/** GET /_boot/db/backups lists retained catalog metadata for a live human session, even without an app. */
export const backupRoute = (
	authStore: AuthStore,
	backupStore: BackupStore,
	captures: BackupCaptureStore,
	config: AuthConfig,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		const create = url.pathname === "/_boot/db/backup" && request.method === "POST";
		if (!create && (request.method !== "GET" || url.pathname !== "/_boot/db/backups")) return null;
		return yield* authFailure(
			Effect.gen(function* () {
				const auth = yield* Ref.get(authStore);
				if (!auth) return authErrorResponse("boot_unavailable", 503);
				if (create) {
					const authorize = Effect.gen(function* () {
						const identity = yield* authenticate(auth, request);
						if (identity.kind !== "human" && !identity.scopes.includes("fs"))
							return yield* new AuthError({ code: "scope_required" });
						if (identity.kind === "human" && request.headers.origin !== config.expectedOrigin)
							return yield* new AuthError({ code: "origin_invalid" });
					});
					yield* authorize;
					if (url.search) return yield* new AuthError({ code: "invalid_request" });
					yield* body(Schema.Record(Schema.String, Schema.Never));
					const service = yield* Ref.get(captures);
					if (!service) return authErrorResponse("boot_unavailable", 503);
					return yield* service.capture({ reason: "manual", authorize }).pipe(
						Effect.map((record) => HttpServerResponse.jsonUnsafe(record, { headers: { "cache-control": "no-store" } })),
						Effect.catchCause((cause) => {
							if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
							const error = Cause.findError(cause);
							if (error._tag === "Success" && Schema.is(AuthError)(error.success)) return Effect.fail(error.success);
							if (
								error._tag === "Success" &&
								(Schema.is(StorageRejected)(error.success) || Schema.is(ArtifactRetentionRejected)(error.success))
							) {
								const unsafe = error.success.code === "unsafe_artifact_path";
								return Effect.succeed(
									HttpServerResponse.jsonUnsafe(
										{
											error: {
												code: error.success.code,
												message: "Backup capture was refused.",
												hint: unsafe
													? "Inspect and repair boot-owned artifact paths before another request."
													: "Free space on the data volume, then retry.",
												retriable: false,
											},
										},
										{ status: unsafe ? 409 : 507, headers: { "cache-control": "no-store" } },
									),
								);
							}
							return Effect.succeed(
								HttpServerResponse.jsonUnsafe(
									{
										error: {
											code: "backup_failed",
											message: "The backup did not complete normally.",
											hint: "A copy may already exist. Inspect /_boot/status and the human backup catalog at /_boot/db/backups before another request.",
											retriable: false,
										},
									},
									{ status: 503, headers: { "cache-control": "no-store" } },
								),
							);
						}),
					);
				}
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
