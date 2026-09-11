import { Schema } from "effect";

export const DatabaseRestoreParams = Schema.Struct({
	backup: Schema.String,
	idempotency_key: Schema.optionalKey(Schema.String),
});
export type DatabaseRestore = typeof DatabaseRestoreParams.Type;
export const DatabaseRestoreInput = Schema.Union([
	DatabaseRestoreParams,
	Schema.Struct({ id: Schema.String, idempotency_key: Schema.optionalKey(Schema.String) }),
]);
export const databaseRestoreParams = (input: typeof DatabaseRestoreInput.Type): DatabaseRestore =>
	"backup" in input
		? input
		: { backup: input.id, ...(input.idempotency_key === undefined ? {} : { idempotency_key: input.idempotency_key }) };
export const validDatabaseBackup = (backup: string) =>
	/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(backup);
export const validDatabaseRestore = (params: DatabaseRestore) =>
	validDatabaseBackup(params.backup) &&
	(params.idempotency_key === undefined || /^[\x20-\x7e]{1,128}$/.test(params.idempotency_key));
export const canonicalDatabaseRestore = (params: DatabaseRestore, sessionId: string) =>
	JSON.stringify({
		backup: params.backup,
		session: sessionId,
		...(params.idempotency_key === undefined ? {} : { idempotency_key: params.idempotency_key }),
	});

export const DatabaseRestoreRequest = Schema.Struct({
	proof_id: Schema.String,
	idempotency_key: Schema.NullOr(Schema.String),
	proof_hash: Schema.String,
	session_id: Schema.String,
	backup: Schema.String,
	phase: Schema.Literals(["authorized", "restoring", "working", "rollback", "restored", "failed"]),
	safety_backup: Schema.NullOr(Schema.String),
	generation: Schema.NullOr(Schema.Int),
	restored_to_seq: Schema.Int,
	event_seq: Schema.NullOr(Schema.Int),
	failure: Schema.NullOr(Schema.String),
	lock_id: Schema.NullOr(Schema.String),
	lock_family: Schema.NullOr(Schema.String),
	lock_owned: Schema.Int,
	candidate_epoch: Schema.NullOr(Schema.String),
});
export type DatabaseRestoreRequest = typeof DatabaseRestoreRequest.Type;
