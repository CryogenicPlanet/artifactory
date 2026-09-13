import type { RemoteStore } from "@comms/storage/store";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { DbOpsService } from "./db-ops.ts";

const messages = {
	remote_restore_recovery_required:
		"An unfinished remote restore remains. Have the operator resolve the provider restore and verify the intended board database before clearing the restore intent; chirp cannot resume a native restore.",
	provider_backup_required:
		"Remote backups belong to the database provider. Create a provider snapshot; chirp does not run database dumps.",
	provider_restore_required:
		"Restore this database through its provider, then restart chirp to verify the board identity before serving.",
	remote_rehearsal_unsupported:
		"Remote data-clone rehearsal is unsupported. Use the schema check; chirp does not create rehearsal databases.",
	remote_database_cleanup_required:
		"An unfinished legacy remote database operation remains in settings (remote_database:*). Have the operator inspect its database, role and artifact before removing the record; chirp will not resume or clean it up.",
	remote_database_invalid:
		"Could not inspect the configured remote database. Verify the existing database, role and connection permissions.",
	backup_engine_mismatch: "This backup was created by a different database engine and cannot be restored here.",
} as const;
export class RemoteDatabaseError extends Schema.TaggedError<RemoteDatabaseError>()("RemoteDatabaseError", {
	code: Schema.Literals([
		"remote_restore_recovery_required",
		"provider_backup_required",
		"provider_restore_required",
		"remote_rehearsal_unsupported",
		"remote_database_cleanup_required",
		"remote_database_invalid",
		"backup_engine_mismatch",
	]),
}) {
	get message() {
		return messages[this.code];
	}
}
export interface RemoteDbOpsOptions {
	readonly store: Effect.Effect<RemoteStore, unknown>;
	readonly withStore: <A, E>(
		store: RemoteStore,
		effect: Effect.Effect<A, E, SqlClient.SqlClient>,
	) => Effect.Effect<A, unknown>;
}
const invalid = () => new RemoteDatabaseError({ code: "remote_database_invalid" });
const refused = (code: typeof RemoteDatabaseError.prototype.code) => Effect.fail(new RemoteDatabaseError({ code }));

/** Remote durability belongs to the provider. This adapter neither creates nor restores databases. */
export const remoteDbOps = (options: RemoteDbOpsOptions) =>
	Effect.gen(function* () {
		const configured = yield* options.store.pipe(Effect.mapError(invalid));
		const engine = configured._tag === "postgres" ? "pg" : "mysql";
		const sql = yield* SqlClient.SqlClient;
		const recover = Effect.gen(function* () {
			const rows =
				yield* sql`SELECT value FROM settings WHERE ${sql("key")} LIKE ${"remote^_database:%"} ESCAPE '^'`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
					Effect.mapError(invalid),
				);
			for (const row of rows) {
				const record = yield* Schema.decodeEffect(
					Schema.fromJsonString(
						Schema.Struct({
							kind: Schema.Literals(["dump", "rehearsal", "restore"]),
							phase: Schema.Literals(["allocated", "ready", "closed"]),
						}),
					),
				)(row.value).pipe(Effect.mapError(() => new RemoteDatabaseError({ code: "remote_database_cleanup_required" })));
				if (record.phase !== "closed" || record.kind !== "restore")
					return yield* refused("remote_database_cleanup_required");
			}
		});
		return {
			engine,
			recoverCopy: recover,
			recoverStaging: recover,
			estimatedBytes: Effect.gen(function* () {
				const selected = yield* options.store;
				return yield* options.withStore(
					selected,
					Effect.gen(function* () {
						const app = yield* SqlClient.SqlClient;
						const rows = yield* (
							engine === "pg"
								? app`SELECT pg_database_size(current_database())::text AS bytes`
								: app`SELECT CAST(COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) AS CHAR) AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()`
						).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ bytes: Schema.String })))));
						const bytes = Number(rows[0]?.bytes);
						if (!Number.isSafeInteger(bytes) || bytes < 0) return yield* invalid();
						return bytes;
					}),
				);
			}).pipe(Effect.mapError(invalid)),
			clone: () => refused("provider_backup_required"),
			prepareClone: () => refused("remote_rehearsal_unsupported"),
			rehearsal: () => refused("remote_rehearsal_unsupported"),
			restoreInto: (artifact) =>
				refused(artifact.engine === engine ? "provider_restore_required" : "backup_engine_mismatch"),
		} satisfies DbOpsService;
	});
