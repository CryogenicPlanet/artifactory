import { RecoveryRejected } from "./recovery-intents.ts";
import { childErrorPolicy } from "./child-error-policy.ts";
import { authErrorResponse } from "./auth-http.ts";
import { Cause, Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { isHttpClientError } from "effect/unstable/http/HttpClientError";
import { ChildError } from "./child-process.ts";
import { AuthError } from "./auth.ts";
import { FreezeTimeout } from "./cutover.ts";
import { EditRejected } from "./edit-lock.ts";
import { ArtifactRetentionRejected } from "./artifact-retention.ts";
import { StorageRejected } from "./storage-headroom.ts";
import { SourceRejected } from "./source-schema.ts";

const conflict = {
	status: 409,
	retriable: false,
	hint: "Read the current source and history, resolve the conflict, then submit a new edit.",
} as const;
const lockRequired = {
	status: 423,
	retriable: false,
	hint: "Inspect GET /api/lock. Acquire your edit lock before changing app source; wait for a pinned operation to finish.",
} as const;
const invalid = {
	status: 400,
	retriable: false,
	hint: "Correct the request path, body or query using GET /_boot and source history.",
} as const;
const storage = {
	status: 507,
	retriable: false,
	hint: "Free space in DATA_DIR or expand its volume, then retry. Protected recovery artifacts are retained.",
} as const;
const unavailable = {
	status: 503,
	retriable: true,
	hint: "Inspect /_boot/status; wait for the active operation or storage contention to finish before retrying.",
} as const;
const policy = {
	topic_move_recovery_required: {
		status: 409,
		retriable: false,
		hint: "Historical topic-move tables require the previous compatible image to finish recovery and retirement. Preserve both stores, page bytes and keeper receipts; do not delete tables to bypass this refusal.",
	},
	recovery_intents_conflict: {
		status: 409,
		retriable: false,
		hint: "Conflicting durable recovery journals need operator inspection. Preserve the journals, store and keeper receipts; do not choose or delete an intent to force recovery.",
	},
	lock_recovery_conflict: {
		status: 409,
		retriable: false,
		hint: "Edit ownership conflicts with durable recovery journals. Preserve the lock, staging and journals; repair ownership before retrying.",
	},
	...childErrorPolicy,
	authority_expired: {
		status: 401,
		retriable: false,
		hint: "Sign in again or refresh your token, then inspect source before retrying the edit.",
	},
	lock_required: lockRequired,
	locked: lockRequired,
	stale_lock: lockRequired,
	cutover_in_flight: lockRequired,
	not_pinned: lockRequired,
	staging_not_empty: {
		status: 423,
		retriable: false,
		hint: "Inspect your staging overlay. Publish or explicitly discard it before reverting source.",
	},
	invalid_ttl: invalid,
	invalid_path: invalid,
	path_conflict: conflict,
	external_conflict: conflict,
	stale_base: { ...conflict, status: 412 },
	idempotency_conflict: conflict,
	invalid_text: invalid,
	version_unavailable: invalid,
	generation_unavailable: invalid,
	batch_missing: invalid,
	proposal_missing: invalid,
	publication_pending: unavailable,
	storage_headroom: storage,
	storage_measurement_failed: {
		status: 503,
		retriable: true,
		hint: "Inspect the DATA_DIR volume and boot storage-probe failure before retrying.",
	},
	backup_budget: storage,
	invalid_storage_sample: {
		status: 507,
		retriable: false,
		hint: "Inspect backup metadata and the storage probe before retrying; protected artifacts were retained.",
	},
	unsafe_artifact_path: {
		status: 409,
		retriable: false,
		hint: "Inspect boot-owned artifact paths before retrying; no unsafe path was deleted.",
	},
	freeze_timeout: unavailable,
	edit_unavailable: unavailable,
	editing_unavailable: unavailable,
	method_invalid: {
		status: 405,
		retriable: false,
		hint: "Use the HTTP method described by GET /_boot for this operation.",
	},
	unsupported_query: invalid,
	invalid_note: invalid,
	revert_selection_invalid: invalid,
	idempotency_key_invalid: invalid,
	query_invalid: invalid,
	precondition_invalid: {
		...invalid,
		hint: "Use one quoted SHA-256 If-Match value from GET ETag, or If-None-Match: * for an absent file.",
	},
	file_not_found: {
		status: 404,
		retriable: false,
		hint: "Browse the parent directory through /api/fs/ and use an existing source path.",
	},
	handler_failed: {
		status: 500,
		retriable: false,
		hint: "Inspect bootloader logs and repair the failed route. This is not an unchanged-retry condition.",
	},
} as const satisfies Readonly<
	Record<
		| ChildError["code"]
		| EditRejected["code"]
		| SourceRejected["code"]
		| StorageRejected["code"]
		| ArtifactRetentionRejected["code"]
		| FreezeTimeout["code"],
		{ readonly status: number; readonly retriable: boolean; readonly hint: string }
	> &
		Record<string, { readonly status: number; readonly retriable: boolean; readonly hint: string }>
>;

export const errorResponse = (
	code: keyof typeof policy,
	status: number = policy[code].status,
	holder?: unknown,
	route = "the requested route",
) =>
	HttpServerResponse.jsonUnsafe(
		{
			error: {
				code,
				message: code === "handler_failed" ? `Handler failed for ${route}.` : "Source edit refused.",
				hint: policy[code].hint,
				retriable: policy[code].retriable,
			},
			...(holder === undefined ? {} : { lock: holder }),
		},
		{ status, headers: { "cache-control": "no-store" } },
	);

export const editFailure = (cause: Cause.Cause<unknown>) => {
	if (Cause.hasInterruptsOnly(cause))
		return Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)));
	const expected =
		cause.reasons.length === 1 &&
		cause.reasons.every(
			(reason) =>
				reason._tag === "Fail" &&
				(Schema.is(RecoveryRejected)(reason.error) ||
					Schema.is(StorageRejected)(reason.error) ||
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
	if (!expected)
		return Effect.gen(function* () {
			const request = Option.getOrUndefined(yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest));
			return errorResponse(
				"handler_failed",
				500,
				undefined,
				request ? `${request.method} ${request.url.split("?")[0]}` : undefined,
			);
		});
	const found = Cause.findError(cause);
	const error = found._tag === "Success" ? found.success : undefined;
	if (Schema.is(AuthError)(error)) return Effect.succeed(authErrorResponse(error.code));
	if (Schema.is(EditRejected)(error))
		return Effect.succeed(errorResponse(error.code, policy[error.code].status, error.holder));
	if (
		Schema.is(RecoveryRejected)(error) ||
		Schema.is(StorageRejected)(error) ||
		Schema.is(ArtifactRetentionRejected)(error) ||
		Schema.is(FreezeTimeout)(error) ||
		Schema.is(SourceRejected)(error) ||
		Schema.is(ChildError)(error)
	)
		return Effect.succeed(errorResponse(error.code));
	return Effect.succeed(errorResponse("edit_unavailable"));
};
