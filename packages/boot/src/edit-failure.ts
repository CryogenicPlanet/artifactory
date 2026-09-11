import { Cause, Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { isHttpClientError } from "effect/unstable/http/HttpClientError";
import { ChildError } from "./child-process.ts";
import { AuthError } from "./auth.ts";
import { FreezeTimeout } from "./cutover.ts";
import { EditRejected } from "./edit-lock.ts";
import { ArtifactRetentionRejected } from "./artifact-retention.ts";
import { StorageRejected } from "./storage-headroom.ts";
import { SourceRejected } from "./source-schema.ts";
import type { BootMetrics } from "./metrics.ts";

export const errorResponse = (code: string, status: number, holder?: unknown) =>
	HttpServerResponse.jsonUnsafe(
		{
			error: {
				code,
				message: "Source edit refused.",
				hint:
					code === "unsafe_artifact_path"
						? "Inspect the boot-owned artifact paths before retrying; no unsafe path was deleted."
						: status === 507
							? "Free space in DATA_DIR or expand its volume, then retry. Protected recovery artifacts are retained."
							: "GET /_boot/status for diagnostics. POST /api/lock before app edits; repair staged source and POST /api/reload to retry.",
				retriable: status === 503,
			},
			...(holder === undefined ? {} : { lock: holder }),
		},
		{ status, headers: { "cache-control": "no-store" } },
	);

export const editFailure = (metrics: BootMetrics) => (cause: Cause.Cause<unknown>) => {
	if (Cause.hasInterruptsOnly(cause))
		return Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)));
	const expected =
		cause.reasons.length > 0 &&
		cause.reasons.every(
			(reason) =>
				reason._tag === "Fail" &&
				(Schema.is(StorageRejected)(reason.error) ||
					Schema.is(ArtifactRetentionRejected)(reason.error) ||
					Schema.is(FreezeTimeout)(reason.error) ||
					Schema.is(EditRejected)(reason.error) ||
					Schema.is(SourceRejected)(reason.error) ||
					Schema.is(AuthError)(reason.error) ||
					Schema.is(ChildError)(reason.error) ||
					Cause.isTimeoutError(reason.error) ||
					isHttpClientError(reason.error) ||
					(isSqlError(reason.error) && reason.error.isRetryable)),
		);
	if (!expected) return Effect.succeed(errorResponse("handler_failed", 500));
	const found = Cause.findError(cause);
	const error = found._tag === "Success" ? found.success : undefined;
	if (Schema.is(StorageRejected)(error) || Schema.is(ArtifactRetentionRejected)(error))
		return Effect.succeed(errorResponse(error.code, error.code === "unsafe_artifact_path" ? 409 : 507));
	if (Schema.is(FreezeTimeout)(error)) return Effect.succeed(errorResponse(error.code, 503));
	if (Schema.is(EditRejected)(error))
		return Effect.as(
			error.code === "locked" || error.code === "cutover_in_flight" ? metrics.lockWait : Effect.void,
			errorResponse(error.code, error.code === "authority_expired" ? 401 : 423, error.holder),
		);
	if (Schema.is(SourceRejected)(error))
		return Effect.succeed(
			errorResponse(
				error.code,
				error.code === "publication_pending"
					? 503
					: ["stale_base", "ambiguous_anchor", "anchor_not_found", "idempotency_conflict"].includes(error.code)
						? 409
						: 400,
			),
		);
	if (Schema.is(AuthError)(error))
		return Effect.succeed(errorResponse(error.code, error.code === "invalid_request" ? 400 : 401));
	return Effect.succeed(errorResponse("edit_unavailable", 503));
};
