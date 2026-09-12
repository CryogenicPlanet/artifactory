import { type FileStore, type RemoteStore, withDatabase } from "@comms/storage/store";
import { RemoteCopyError, type RemoteArtifact } from "@comms/storage/remote-copy";
import { Cause, Config, Duration, Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { EventError } from "./events.ts";
import { remoteAppStoreIdentity, verifyRemoteAppIdentity } from "./app-store-identity.ts";
import type { BackupRecord } from "./backup-metadata.ts";
import { remoteDatabaseJournal, RemoteDatabaseError, type RemoteDatabaseRecord } from "./remote-database-journal.ts";
import type { DbOpsService } from "./db-ops.ts";
import { mysqlDatabaseProvision } from "./mysql-database-provision.ts";
import { postgresDatabaseProvision } from "./postgres-database-provision.ts";
import { storageHeadroom } from "./storage-headroom.ts";

type NativeRequest = {
	readonly resourceId: string;
	readonly store: RemoteStore;
	readonly budgetMs: number;
} & (
	| { readonly operation: "dump"; readonly path: string }
	| { readonly operation: "load"; readonly artifact: RemoteArtifact; readonly ownership: "current-role" | "preserve" }
);
export interface RemoteDbOpsOptions {
	readonly store: Effect.Effect<RemoteStore, unknown>;
	readonly bootStore: RemoteStore;
	readonly dataDirectory: string;
	/** The root derives boot credentials for selected database and registers every SQL lease. Never uses selected app password. */
	readonly withStore: <A, E>(
		store: RemoteStore,
		effect: Effect.Effect<A, E, SqlClient.SqlClient>,
	) => Effect.Effect<A, unknown>;
	readonly withNative: (request: NativeRequest) => Effect.Effect<RemoteArtifact & { readonly bytes: number }, unknown>;
	readonly assertAccountClosed: (resourceId: string, store: RemoteStore) => Effect.Effect<void, unknown>;
}
const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.catchCause((cause): Effect.Effect<never, RemoteDatabaseError | RemoteCopyError | EventError> => {
			if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
			const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined;
			if (reason && Cause.isFailReason(reason)) {
				const error = reason.error;
				if (Schema.is(RemoteDatabaseError)(error) || Schema.is(RemoteCopyError)(error) || Schema.is(EventError)(error))
					return Effect.fail(error);
			}
			return Effect.fail(new RemoteDatabaseError({ code: "remote_database_provision_failed" }));
		}),
	);

/** The surviving root owns SQL/native sessions; this service owns resource allocation and copy policy. */
export const remoteDbOps = (options: RemoteDbOpsOptions) =>
	Effect.gen(function* () {
		const configured = yield* safe(options.store);
		const engine: "pg" | "mysql" = configured._tag === "postgres" ? "pg" : "mysql";
		const journal = yield* remoteDatabaseJournal(options.bootStore, options.dataDirectory);
		const mysqlProvision = mysqlDatabaseProvision(journal);
		const selectedProvision: Effect.Effect<
			Effect.Success<typeof postgresDatabaseProvision> | Effect.Success<typeof mysqlProvision>,
			Effect.Error<typeof postgresDatabaseProvision> | Effect.Error<typeof mysqlProvision>,
			SqlClient.SqlClient
		> = engine === "pg" ? postgresDatabaseProvision : mysqlProvision;
		const provision = yield* selectedProvision;
		const identity = yield* remoteAppStoreIdentity(configured);
		const headroom = yield* storageHeadroom(options.dataDirectory);
		const budgetMs = yield* Config.Duration("REHEARSAL_COPY_BUDGET").pipe(
			Config.withDefault(Duration.seconds(120)),
			Effect.map(Duration.toMillis),
		);
		const limit = yield* Config.Number("SCRATCH_DATABASE_LIMIT").pipe(Config.withDefault(4));
		if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || !Number.isSafeInteger(limit) || limit <= 0)
			return yield* new RemoteDatabaseError({ code: "remote_database_invalid" });
		const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			safe(
				effect.pipe(
					Effect.timeoutOrElse({
						duration: budgetMs,
						orElse: () => Effect.fail(new RemoteCopyError({ code: "rehearsal_copy_timeout" })),
					}),
				),
			);
		const withStore = <A, E>(store: RemoteStore, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
			safe(options.withStore(store, effect));
		const closed = (record: RemoteDatabaseRecord, store: RemoteStore) =>
			safe(options.assertAccountClosed(record.id, store));
		const finishDump = (record: RemoteDatabaseRecord, store: RemoteStore) =>
			Effect.gen(function* () {
				yield* closed(record, store);
				const saved = yield* journal.read(record.id);
				const done = saved.phase === "closed" ? saved : yield* journal.phase(saved.id, "ready", "closed");
				yield* withStore(store, selectedProvision.pipe(Effect.flatMap((service) => service.revokeDump(done))));
				yield* provision.dropPrincipal(done);
				yield* journal.forget(done.id);
			});
		const finishRehearsal = (id: string, store: RemoteStore) =>
			Effect.gen(function* () {
				yield* closed(yield* journal.read(id), store);
				const saved = yield* journal.read(id);
				const done = saved.phase === "closed" ? saved : yield* journal.phase(saved.id, "ready", "closed");
				yield* provision.dropRehearsal(done);
				yield* journal.forget(done.id);
			});
		const estimatedBytes = safe(
			Effect.gen(function* () {
				const selected = yield* options.store;
				return yield* withStore(
					selected,
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const rows = yield* (
							engine === "pg"
								? sql`SELECT pg_database_size(current_database())::text AS bytes`
								: sql`SELECT CAST(COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) AS CHAR) AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()`
						).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ bytes: Schema.String })))));
						const bytes = Number(rows[0]?.bytes);
						if (!Number.isSafeInteger(bytes) || bytes < 0)
							return yield* new RemoteDatabaseError({ code: "remote_database_invalid" });
						return bytes;
					}),
				);
			}),
		);
		const clone = (destination: FileStore) =>
			bounded(
				Effect.gen(function* () {
					yield* headroom.check(yield* estimatedBytes);
					const source = yield* options.store;
					const record = yield* journal.allocate("dump", source);
					const credential = yield* journal.credential(record.id);
					yield* provision.createPrincipal(record, credential);
					yield* withStore(source, selectedProvision.pipe(Effect.flatMap((service) => service.grantDump(record))));
					const ready = yield* journal.phase(record.id, "allocated", "ready");
					const artifact = yield* options.withNative({
						operation: "dump",
						resourceId: record.id,
						store: credential,
						path: destination.filename,
						budgetMs,
					});
					yield* finishDump(ready, credential);
					return BigInt(artifact.bytes);
				}),
			);
		const load = (kind: "rehearsal" | "restore", artifact: RemoteArtifact) =>
			safe(
				Effect.gen(function* () {
					if (artifact.engine !== engine) return yield* new RemoteCopyError({ code: "backup_engine_mismatch" });
					if (
						kind === "rehearsal" &&
						(yield* journal.list).filter((record) => record.kind === "rehearsal").length >= limit
					)
						return yield* new RemoteDatabaseError({ code: "scratch_limit" });
					const source = yield* options.store;
					const record = yield* journal.allocate(kind, source);
					const credential = yield* journal.credential(record.id);
					yield* provision.createPrincipal(record, credential);
					yield* provision.createDatabase(record);
					yield* withStore(
						credential,
						selectedProvision.pipe(Effect.flatMap((service) => service.grantSchema(record))),
					);
					const ready = yield* journal.phase(record.id, "allocated", "ready");
					yield* options.withNative({
						operation: "load",
						resourceId: record.id,
						store: credential,
						artifact,
						ownership: engine === "pg" ? "current-role" : "preserve",
						budgetMs,
					});
					yield* closed(ready, credential);
					yield* withStore(
						credential,
						selectedProvision.pipe(Effect.flatMap((service) => service.protectKernel(record))),
					);
					return { record: ready, store: credential, source };
				}),
			);
		return {
			engine,
			// Native copies already await their keeper proof; startup remote journal recovery stays below.
			recoverCopy: Effect.void,
			estimatedBytes,
			clone,
			prepareClone: (_clone: FileStore, _epoch: string) =>
				Effect.fail(new RemoteDatabaseError({ code: "remote_database_invalid" })),
			recoverStaging: safe(
				Effect.gen(function* () {
					for (const record of yield* journal.list) {
						// Incomplete provisioning and all restore targets are retained for explicit recovery.
						if (record.phase === "allocated" || record.kind === "restore") continue;
						if (record.phase === "closed") {
							// The durable phase records closure; secret deletion may already have succeeded.
							if (record.kind === "rehearsal") yield* provision.dropRehearsal(record);
							else {
								const source = yield* withDatabase(options.bootStore, record.database);
								yield* withStore(
									source,
									selectedProvision.pipe(Effect.flatMap((service) => service.revokeDump(record))),
								);
								yield* provision.dropPrincipal(record);
							}
							yield* journal.forget(record.id);
							continue;
						}
						const credential = yield* journal.credential(record.id);
						if (record.kind === "dump") yield* finishDump(record, credential);
						else yield* finishRehearsal(record.id, credential);
					}
				}),
			),
			rehearsal: (destination: FileStore, epoch: string, artifact?: BackupRecord) =>
				bounded(
					Effect.gen(function* () {
						if (artifact && artifact.engine !== engine)
							return yield* new RemoteCopyError({ code: "backup_engine_mismatch" });
						if (!artifact) yield* clone(destination);
						const loaded = yield* load("rehearsal", { path: artifact?.path ?? destination.filename, engine });
						yield* withStore(
							loaded.store,
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient;
								yield* sql`UPDATE kernel_writer SET epoch=${epoch} WHERE singleton=1`;
							}),
						);
						return { store: loaded.store, dispose: safe(finishRehearsal(loaded.record.id, loaded.store)) };
					}),
				),
			restoreInto: (artifact: Pick<BackupRecord, "path" | "legacy_store_id" | "engine">) =>
				bounded(
					Effect.gen(function* () {
						if (artifact.engine !== engine) return yield* new RemoteCopyError({ code: "backup_engine_mismatch" });
						const loaded = yield* load("restore", { path: artifact.path, engine });
						const adoption = yield* identity.reserve;
						const appRole = yield* Effect.try({
							try: () => decodeURIComponent(new URL(Redacted.value(loaded.source.url)).username),
							catch: () => new RemoteDatabaseError({ code: "remote_database_invalid" }),
						});
						yield* withStore(
							loaded.store,
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient;
								const target = yield* selectedProvision;
								if (engine === "pg")
									yield* sql.withTransaction(
										Effect.gen(function* () {
											yield* verifyRemoteAppIdentity(adoption);
											yield* target.handoff(loaded.record, appRole);
										}),
									);
								else {
									yield* sql.withTransaction(verifyRemoteAppIdentity(adoption));
									// MySQL GRANT commits implicitly; this fresh target remains unselected.
									yield* target.handoff(loaded.record, appRole);
								}
							}),
						);
						const done = yield* journal.phase(loaded.record.id, "ready", "closed");
						yield* provision.dropPrincipal(done);
						yield* journal.forget(done.id);
						return yield* withDatabase(loaded.source, loaded.record.database);
					}),
				),
		} satisfies DbOpsService;
	});
