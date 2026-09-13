import { tokenExpiresHeader } from "@comms/protocol/headers";
import { RemoteDatabaseError } from "./remote-db-ops.ts";
import { bootRoute, checkBootOrigin } from "./boot-route.ts";
import { isAppStoreIdentityError, appIdentityPolicy, transferPolicy } from "./app-store-identity.ts";
import { childErrorPolicy } from "./child-error-policy.ts";
import { PlatformError } from "effect/PlatformError";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { isHttpClientError } from "effect/unstable/http/HttpClientError";
import { ChildError } from "./child-process.ts";
import { Cause, Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth } from "./auth.ts";
import { authErrorResponse, authFailure, authenticate, body, humanSession } from "./auth-http.ts";
import type { DatabaseBackup } from "./database-backup.ts";
import { StorageRejected } from "./storage-headroom.ts";
import { ArtifactRetentionRejected } from "./artifact-retention.ts";
import { BackupCursor, type BackupInventory } from "./backup-inventory.ts";

/** GET /_boot/db/backups lists retained catalog metadata for a live human session, even without an app. */
export const backupRoute = (auth: Auth["Service"], list: BackupInventory, service: DatabaseBackup) =>
	Effect.gen(function* () {
		const { request, url } = yield* bootRoute;
		const create = url.pathname === "/_boot/db/backup" && request.method === "POST";
		if (!create && (request.method !== "GET" || url.pathname !== "/_boot/db/backups")) return null;
		return yield* authFailure(
			Effect.gen(function* () {
				if (create) {
					const authorize = Effect.gen(function* () {
						const identity = yield* authenticate(auth, request);
						if (identity.kind !== "human" && !identity.scopes.includes("fs"))
							return yield* new AuthError({ code: "scope_required" });
						yield* checkBootOrigin("backupWrite", request, auth, identity.kind);
					});
					yield* authorize;
					if (url.search) return yield* new AuthError({ code: "invalid_request" });
					yield* body(Schema.Record(Schema.String, Schema.Never));
					return yield* service.capture({ reason: "manual", authorize }).pipe(
						Effect.map((record) =>
							HttpServerResponse.jsonUnsafe(
								{
									id: record.id,
									engine: record.engine,
									reason: record.reason,
									bytes: record.bytes,
									taken_at: record.taken_at,
									published_through: record.published_through,
									generation: record.generation,
								},
								{ headers: { "cache-control": "no-store" } },
							),
						),
						Effect.catchCause((cause) => {
							const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined;
							if (reason?._tag === "Fail" && Schema.is(RemoteDatabaseError)(reason.error))
								return Effect.succeed(
									HttpServerResponse.jsonUnsafe(
										{
											error: {
												code: reason.error.code,
												message: reason.error.message,
												hint: reason.error.message,
												retriable: false,
											},
										},
										{ status: 409, headers: { "cache-control": "no-store" } },
									),
								);
							if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
							const unexpected =
								cause.reasons.length !== 1 ||
								cause.reasons.some(
									(reason) =>
										reason._tag !== "Fail" ||
										!(
											isAppStoreIdentityError(reason.error) ||
											Schema.is(AuthError)(reason.error) ||
											Schema.is(StorageRejected)(reason.error) ||
											Schema.is(ArtifactRetentionRejected)(reason.error) ||
											Schema.is(ChildError)(reason.error) ||
											reason.error instanceof PlatformError ||
											Cause.isTimeoutError(reason.error) ||
											isHttpClientError(reason.error) ||
											(isSqlError(reason.error) && reason.error.isRetryable)
										),
								);
							if (unexpected)
								return Effect.succeed(authErrorResponse("handler_failed", 500, `${request.method} ${url.pathname}`));
							const error = Cause.findError(cause);
							if (error._tag === "Success" && isAppStoreIdentityError(error.success))
								return Effect.succeed(
									HttpServerResponse.jsonUnsafe(
										{
											error: {
												code: error.success.code,
												message: "App store identity could not be verified.",
												hint:
													error.success.code === "store_transferred" ||
													error.success.code === "store_transfer_incomplete"
														? transferPolicy[error.success.code].hint
														: appIdentityPolicy.hint,
												retriable: false,
											},
										},
										{ status: 409, headers: { "cache-control": "no-store" } },
									),
								);
							if (error._tag === "Success" && Schema.is(AuthError)(error.success)) return Effect.fail(error.success);
							if (error._tag === "Success" && Schema.is(ChildError)(error.success)) {
								const policy = childErrorPolicy[error.success.code];
								// Capture may have committed before resuming its child failed. Never invite an automatic second copy.
								return Effect.succeed(
									HttpServerResponse.jsonUnsafe(
										{
											error: {
												code: error.success.code,
												message: "Backup capture did not complete normally.",
												hint: `${policy.retriable ? "Wait for boot to become available." : policy.hint} A copy may already exist; inspect /_boot/db/backups before another capture.`,
												retriable: false,
											},
										},
										{ status: policy.status, headers: { "cache-control": "no-store" } },
									),
								);
							}
							if (
								error._tag === "Success" &&
								(Schema.is(StorageRejected)(error.success) || Schema.is(ArtifactRetentionRejected)(error.success))
							) {
								const unsafe = error.success.code === "unsafe_artifact_path";
								const unavailable = error.success.code === "storage_measurement_failed";
								return Effect.succeed(
									HttpServerResponse.jsonUnsafe(
										{
											error: {
												code: error.success.code,
												message: "Backup capture was refused.",
												hint: unsafe
													? "Inspect and repair boot-owned artifact paths before another request."
													: unavailable
														? "Inspect the storage probe and retry after measurements recover."
														: "Free space on the data volume, then retry.",
												retriable: unavailable,
											},
										},
										{ status: unsafe ? 409 : unavailable ? 503 : 507, headers: { "cache-control": "no-store" } },
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
						[tokenExpiresHeader]: String(session.expiresAt),
					},
				});
			}),
		).pipe(Effect.map(HttpServerResponse.setHeader("x-content-type-options", "nosniff")));
	});
