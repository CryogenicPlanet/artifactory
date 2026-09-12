import type { RemoteDatabaseError } from "./remote-database-journal.ts";
import type { RemoteCopyError } from "@comms/storage/remote-copy";
import type { EventError } from "./events.ts";
import { sqliteCopyProcess } from "./sqlite-copy-process.ts";
import { ChildError } from "./child-process.ts";
import { appStoreIdentity, verifyAppIdentity } from "./app-store-identity.ts";
import type { BackupRecord } from "./backup-metadata.ts";
import { clientLayer } from "@comms/storage/client";
import type { FileStore, Store } from "@comms/storage/store";
import { Config, Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { storageHeadroom } from "./storage-headroom.ts";

/** SQLite online copies include committed WAL pages. Call restore only after proving all owners closed. */
const make = (store: FileStore, dataDirectory: string) =>
	Effect.gen(function* () {
		const isolated = yield* Config.Boolean("COMMS_ISOLATED").pipe(Config.withDefault(false));
		const fs = yield* FileSystem.FileSystem;
		const filename = store.filename;
		const identity = yield* appStoreIdentity(filename, dataDirectory);
		const path = yield* Path.Path;
		const headroom = yield* storageHeadroom(dataDirectory);
		const copying = yield* sqliteCopyProcess(filename, dataDirectory);
		const estimatedBytes = Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const counts = yield* sql`PRAGMA page_count`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ page_count: Schema.Int })))),
				);
				const sizes = yield* sql`PRAGMA page_size`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ page_size: Schema.Int })))),
				);
				return (counts[0]?.page_count ?? 0) * (sizes[0]?.page_size ?? 0);
			}).pipe(Effect.provide(clientLayer(store))),
		);
		const sync = (name: string) => Effect.scoped(fs.open(name).pipe(Effect.flatMap((file) => file.sync)));
		const operations = {
			engine: "sqlite" as const,
			recoverStaging: copying.recover.pipe(
				Effect.andThen(
					Effect.forEach(
						[".restore-staging", ".restore", ".restore-wal", ".restore-shm", ".restore-journal"],
						(suffix) => fs.remove(`${filename}${suffix}`, { recursive: true, force: true }),
						{ discard: true },
					),
				),
			),
			estimatedBytes,
			recoverCopy: copying.recover,
			clone: (destination: FileStore) =>
				copying.recover.pipe(
					Effect.andThen(estimatedBytes),
					Effect.flatMap((bytes) => headroom.check(bytes)),
					Effect.andThen(copying.copy(destination.filename)),
				),
			prepareClone: (clone: FileStore, epoch: string) =>
				Effect.scoped(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`UPDATE kernel_writer SET epoch=${epoch} WHERE singleton=1`;
					}).pipe(Effect.provide(clientLayer(clone))),
				),
			restoreInto: (backup: Pick<BackupRecord, "path" | "legacy_store_id" | "engine">) =>
				Effect.scoped(
					Effect.gen(function* () {
						if (backup.engine !== "sqlite") return yield* new ChildError({ code: "backup_engine_mismatch" });
						yield* copying.recover;
						// Serialized restore owns this disposable path after positive owner closure.
						// Remove the entire prior copy, including a killed SQLite transaction's sidecars.
						const directory = `${filename}.restore-staging`;
						yield* fs.remove(directory, { recursive: true, force: true });
						yield* fs.makeDirectory(directory);
						yield* Effect.addFinalizer(() => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie));
						const temporary = path.join(directory, "store.db");
						const adoption = yield* identity.current;
						yield* fs.copyFile(backup.path, temporary);
						yield* Effect.scoped(
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient;
								yield* sql`PRAGMA synchronous = FULL`;
								yield* sql.withTransaction(verifyAppIdentity(adoption, backup.legacy_store_id === adoption.store_id));
							}).pipe(Effect.provide(clientLayer({ _tag: "file", filename: temporary }))),
						);
						if (isolated) yield* fs.chmod(temporary, 0o660);
						yield* sync(temporary);
						// The caller has positive closure evidence for every process that could own these handles.
						for (const suffix of ["-wal", "-shm"]) yield* fs.remove(`${filename}${suffix}`, { force: true });
						yield* fs.rename(temporary, filename);
						yield* sync(path.dirname(filename));
						return store;
					}),
				),
		};
		return {
			...operations,
			rehearsal: (destination: FileStore, epoch: string, artifact?: BackupRecord) =>
				Effect.gen(function* () {
					if (artifact) {
						if (artifact.engine !== "sqlite") return yield* new ChildError({ code: "backup_engine_mismatch" });
						yield* fs.copyFile(artifact.path, destination.filename);
					} else yield* operations.clone(destination);
					yield* operations.prepareClone(destination, epoch);
					// The coordinator owns this file inside its materialized source tree.
					return { store: destination, dispose: Effect.void };
				}),
		};
	});
type Operations = Effect.Success<ReturnType<typeof make>>;
type RemoteFailure = RemoteDatabaseError | RemoteCopyError | EventError;
type Result<A, T extends Effect.Effect<unknown, unknown, unknown>> = Effect.Effect<
	A,
	Effect.Error<T> | RemoteFailure,
	Effect.Services<T>
>;
type Rehearsal = ReturnType<Operations["rehearsal"]>;
/** A common effect shape keeps the coordinator independent of native versus file mechanics. */
export interface DbOpsService {
	readonly engine: "sqlite" | "pg" | "mysql";
	readonly estimatedBytes: Result<number, Operations["estimatedBytes"]>;
	readonly recoverStaging: Result<void, Operations["recoverStaging"]>;
	readonly recoverCopy: Result<void, Operations["recoverCopy"]>;
	readonly clone: (destination: FileStore) => Result<bigint, ReturnType<Operations["clone"]>>;
	readonly prepareClone: (clone: FileStore, epoch: string) => Result<void, ReturnType<Operations["prepareClone"]>>;
	readonly restoreInto: (
		artifact: Parameters<Operations["restoreInto"]>[0],
	) => Result<Store, ReturnType<Operations["restoreInto"]>>;
	readonly rehearsal: (
		...args: Parameters<Operations["rehearsal"]>
	) => Result<{ readonly store: Store; readonly dispose: Result<void, Rehearsal> }, Rehearsal>;
}
export class DbOps extends Context.Service<DbOps, DbOpsService>()("comms/boot/DbOps") {}
export const layer = (store: FileStore, dataDirectory: string) => Layer.effect(DbOps, make(store, dataDirectory));
