import { ChildError } from "./child-process.ts";
import { appStoreIdentity, verifyAppIdentity } from "./app-store-identity.ts";
import type { BackupRecord } from "./backup-metadata.ts";
import { clientLayer } from "@comms/storage/client";
import type { FileStore } from "@comms/storage/store";
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
		return {
			dialect: "sqlite" as const,
			recoverStaging: Effect.forEach(
				[".restore-staging", ".restore", ".restore-wal", ".restore-shm", ".restore-journal"],
				(suffix) => fs.remove(`${filename}${suffix}`, { recursive: true, force: true }),
				{ discard: true },
			),
			estimatedBytes,
			clone: (destination: FileStore) =>
				Effect.scoped(
					Effect.gen(function* () {
						yield* headroom.check(yield* estimatedBytes);
						const sql = yield* SqlClient.SqlClient;
						yield* sql`PRAGMA busy_timeout = 2000`;
						yield* sql`VACUUM INTO ${destination.filename}`;
						yield* sync(destination.filename);
						yield* sync(path.dirname(destination.filename));
						return (yield* fs.stat(destination.filename)).size;
					}).pipe(Effect.provide(clientLayer(store))),
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
					}),
				),
		};
	});
export class DbOps extends Context.Service<DbOps, Effect.Success<ReturnType<typeof make>>>()("comms/boot/DbOps") {}
export const layer = (store: FileStore, dataDirectory: string) => Layer.effect(DbOps, make(store, dataDirectory));
