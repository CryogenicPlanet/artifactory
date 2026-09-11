import { Schema } from "effect";
import { HttpApiSchema } from "effect/unstable/httpapi";
import { KernelErrorCode } from "./error-code.ts";

export const policy = {
	boot_handler_failed: {
		status: 500,
		message: "The bootloader could not complete the operation.",
		hint: "Inspect bootloader logs and recovery state. This failure is not an unchanged-retry condition.",
	},
	backup_budget: {
		status: 507,
		message: "Protected backups leave insufficient room in the backup budget.",
		hint: "Review retained backups and protected recovery operations before requesting another copy.",
	},
	invalid_storage_sample: {
		status: 507,
		message: "Backup storage capacity could not be measured reliably.",
		hint: "Restore storage measurement before requesting another copy.",
	},
	unsafe_artifact_path: {
		status: 409,
		message: "A retained artifact path failed its integrity check.",
		hint: "Inspect the boot-owned artifact paths and preserve their recovery references before trying again.",
	},
	event_storage_over_budget: {
		status: 507,
		message: "Retained event pages exceed their storage budget.",
		hint: "Inspect boot event storage maintenance and resolve protected or unprunable data before retrying the original request with its original Idempotency-Key.",
	},
	event_storage_unavailable: {
		status: 503,
		message: "The event storage budget could not be measured.",
		hint: "Restore event storage measurement before retrying the original request with its original Idempotency-Key.",
	},
	storage_headroom: {
		status: 507,
		message: "The data volume has insufficient reserved headroom.",
		hint: "Free space on the data volume, then retry the original request with its original Idempotency-Key.",
	},
	storage_measurement_failed: {
		status: 503,
		message: "The data volume's available capacity could not be measured.",
		hint: "Restore the volume capacity probe before retrying the original request with its original Idempotency-Key.",
	},
	public_pages_limit: {
		status: 500,
		message: "The public page grant snapshot exceeds its activation limit.",
		hint: "Reduce public topic grants to at most 4096 paths and 512 KiB of encoded paths, then reload. Inspect invalid public topic paths if the count remains over the limit.",
	},
	topic_move_evidence_invalid: {
		status: 409,
		message: "Page move ownership could not be verified.",
		hint: "Inspect the original and destination page trees and retained move record. Preserve both; repair the conflicting path before retrying the original key.",
	},
	topic_move_pending: {
		status: 409,
		message: "An overlapping page move is unfinished.",
		hint: "Retry the original unfinished move with its original Idempotency-Key if one was supplied before starting another overlapping move.",
	},
	idempotency_migration_invalid: {
		status: 500,
		message: "Retained idempotency history cannot be migrated safely.",
		hint: "Inspect the startup error and repair incompatible receipt data or its migration. Preserve original outcomes; do not retry or discard history blindly.",
	},
	unsupported_media_type: {
		status: 415,
		message: "The request content type is unsupported.",
		hint: "Send Content-Type: application/json for this JSON endpoint.",
	},
	extension_disabled: {
		status: 500,
		message: "The extension is disabled for this generation.",
		hint: "Inspect /api/ext, repair the source, then reload.",
	},
	extension_migration_conflict: {
		status: 409,
		message: "The applied extension migration has different SQL.",
		hint: "Keep the applied migration unchanged and use a new migration name for the next change.",
	},
	extension_migration_invalid: {
		status: 400,
		message: "The extension migration name or statement is invalid.",
		hint: "Use a valid migration name and one supported, nonempty SQL statement.",
	},
	scope_required: {
		status: 403,
		message: "The required scope is missing.",
		hint: "Use credentials granted the route's required scope. Request a human-approved enrollment to change scopes.",
	},
	author_required: {
		status: 403,
		message: "Only the authoring instance or a human may change this message.",
		hint: "Use the original authoring instance's credentials or a human session. Another instance of the same agent is a different author.",
	},
	topic_not_found: {
		status: 404,
		message: "The topic does not exist.",
		hint: "Check the topic path with GET /api/topics. Deleted topics remain unavailable.",
	},
	message_not_found: {
		status: 404,
		message: "The message does not exist.",
		hint: "Use a message reference returned by a message read. Deleted messages remain unavailable.",
	},
	idempotency_conflict: {
		status: 409,
		message: "The idempotency key belongs to a different request.",
		hint: "Retry the original unchanged request with its original Idempotency-Key if one was supplied. Use a new key only for an intentionally new operation.",
	},
	topic_exists: {
		status: 409,
		message: "The destination topic already exists.",
		hint: "Choose a destination whose topic subtree and page directory do not already exist.",
	},
	topic_archived: {
		status: 409,
		message: "The topic is archived.",
		hint: "Unarchive the topic and its archived ancestors before changing it.",
	},
	cursor_ahead: {
		status: 400,
		message: "The cursor is ahead of the publication fence.",
		hint: "Use a cursor returned by this board, or omit since to begin at its current publication fence.",
	},
	input_invalid: {
		status: 400,
		message: "The request body or path is invalid.",
		hint: "Check the declared JSON fields, path grammar and size limits at /api. Remove unknown fields and send a valid JSON body.",
	},
	query_invalid: {
		status: 400,
		message: "The query is invalid.",
		hint: "Check query parameters at /api. Use a nonnegative integer since from a returned cursor, and include each parameter only once.",
	},
	sql_unsupported: {
		status: 501,
		message: "This SQL operation is not supported.",
		hint: "Use one supported data or schema statement. Transaction control, PRAGMA, attachments, triggers, temporary objects and recovery tables are unavailable. Remove comments and semicolons; bind literal text as parameters.",
	},
	sql_query_timeout: {
		status: 408,
		message: "The readonly SQL query exceeded its execution budget.",
		hint: "Reduce query cost or add an index before trying again. The isolated reader was stopped; the application remains available.",
	},
	sql_query_invalid: {
		status: 400,
		message: "The SQL statement, parameters or returned values are invalid.",
		hint: "Check statement syntax, parameter count and constraints. Cast BLOBs or unsafe integers to text, and keep returned JSON under 128 KiB.",
	},
	sql_publication_pending: {
		status: 503,
		message: "A SQL repair is committed but has not finished event publication.",
		hint: "Retry the read after publication recovers. Retry a write only with its original unchanged Idempotency-Key.",
	},
	boot_unavailable: {
		status: 503,
		message: "The boot channel is temporarily unavailable.",
		hint: "Retry the unchanged request with the same Idempotency-Key. If it persists, inspect authenticated /_boot/status.",
	},
	generation_not_live: {
		status: 503,
		message: "This generation cannot currently accept the operation.",
		hint: "Retry the unchanged request through the public board address after the generation transition.",
	},
	stale_writer: {
		status: 503,
		message: "This generation no longer owns the database writer epoch.",
		hint: "Retry the unchanged request through the public board address so it reaches the current generation.",
	},
	app_schema_unsupported: {
		status: 500,
		message: "The app database schema is unsupported by this generation.",
		hint: "Fix the app migration or restore compatible source through /api/revert. Inspect /_boot/status before changing data.",
	},
	batch_missing: {
		status: 500,
		message: "A committed mutation batch is missing.",
		hint: "Inspect authenticated /_boot/status and repair the app's mutation evidence. Do not retry or remove recovery evidence blindly.",
	},
	event_cursor_invalid: {
		status: 500,
		message: "An event consumer produced an invalid cursor.",
		hint: "Fix the event consumer to preserve the sequence and cursor contract before retrying.",
	},
	health_context_invalid: {
		status: 500,
		message: "The topic context health check failed.",
		hint: "Fix the edited topic handler, then rehearse or reload again.",
	},
	health_create_invalid: {
		status: 500,
		message: "The message creation health check failed.",
		hint: "Fix the edited message creation handler, then rehearse or reload again.",
	},
	health_read_invalid: {
		status: 500,
		message: "The message read health check failed.",
		hint: "Fix the edited message reader, then rehearse or reload again.",
	},
	health_response_too_large: {
		status: 500,
		message: "A health response exceeded its size limit.",
		hint: "Fix the edited health route to return a bounded response, then rehearse or reload again.",
	},
	health_route_failed: {
		status: 500,
		message: "A required route failed its health check.",
		hint: "Inspect the generation failure and fix or revert the edited route before reloading.",
	},
	health_failed: {
		status: 500,
		message: "The generation health check failed.",
		hint: "Inspect the generation failure and fix or revert the edited source before reloading.",
	},
	rehearsal_append_forbidden: {
		status: 500,
		message: "Rehearsal attempted to publish production events.",
		hint: "Fix the edited handler to suppress event publication during rehearsal.",
	},
	rehearsal_events_forbidden: {
		status: 500,
		message: "Rehearsal attempted to read production events.",
		hint: "Fix the edited handler to respect the rehearsal lifecycle boundary.",
	},
	rehearsal_reservation_conflict: {
		status: 500,
		message: "Rehearsal sequence reservations conflict.",
		hint: "Fix the edited mutation to use one correctly sized reservation per transaction.",
	},
} as const satisfies Readonly<
	Record<typeof KernelErrorCode.Type, { readonly status: number; readonly message: string; readonly hint: string }>
>;

/** The same status-specific envelope codecs describe and encode app refusals. */
export const errorSchema = <const Code extends string>(code: Code, status: number) =>
	Schema.Struct({
		error: Schema.Struct({
			code: Schema.Literal(code),
			message: Schema.String,
			hint: Schema.String,
			retriable: Schema.Literal(status === 503),
		}),
	}).pipe(HttpApiSchema.status(status));
const codes = [...KernelErrorCode.literals, "store_unavailable", "handler_failed"] as const;
export const errorSchemas = Object.freeze(
	codes.map((code) =>
		errorSchema(code, code === "store_unavailable" ? 503 : code === "handler_failed" ? 500 : policy[code].status),
	),
);
export const ErrorEnvelope = Schema.Union(errorSchemas);
export const encodeError = Schema.encodeSync(Schema.fromJsonString(ErrorEnvelope));
