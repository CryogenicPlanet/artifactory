import { Effect, FileSystem, Path, Ref } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppBackup } from "./app-backup.ts";
import { AppRecovery } from "./app-recovery.ts";
import type { ChildAttempts } from "./child-attempts.ts";
import { ChildError } from "./child-process.ts";
import type { DatabaseRestoreRequest } from "./database-restore-schema.ts";
import { Events } from "./events.ts";
import { GenerationPreparation } from "./generation-preparation.ts";
import { generationSource } from "./generation-source.ts";
import { Generations } from "./generations.ts";
import { copySource, Snapshots, layer as snapshotsLayer } from "./snapshots.ts";
import { storageHeadroom } from "./storage-headroom.ts";
import type { Supervisor } from "./supervisor.ts";

/** Prepare selected source against its exact backup before freezing the current app.
 * This creates an immutable candidate; editable source is published only at acceptance. */
export const prepareRestoreGeneration = Effect.fn("prepareRestoreGeneration")(function* (
	record: DatabaseRestoreRequest,
	backupPath: string,
	supervisor: Supervisor,
) {
	const sql = yield* SqlClient.SqlClient;
	const generations = yield* Generations;
	const recovery = yield* AppRecovery;
	const backup = yield* AppBackup;
	const events = yield* Events;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = recovery.dataDirectory;
	const context = yield* Effect.context<Generations | AppRecovery | ChildAttempts>();
	const source = (yield* generations.list).find((item) => item.n === record.source_generation && item.good === 1);
	if (!source) return yield* new ChildError({ code: "restore_snapshot_missing" });
	const directory = yield* generationSource(root, source.n);
	const temporarySource = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: ".restore-source-" });
	const materialized = path.join(temporarySource, "app");
	yield* copySource(directory, materialized);
	const candidate = yield* generations.reserve(source.entry_file);
	// Persist before any preparation: retention and interrupted authorization own this reservation.
	yield* sql`UPDATE db_restore_requests SET generation=${candidate.n} WHERE proof_id=${record.proof_id}`;
	const generationsDirectory = path.join(root, "gen");
	const snapshots = yield* Snapshots.pipe(
		Effect.provide(snapshotsLayer({ sourceDirectory: materialized, generationsDirectory })),
	);
	const snapshot = yield* snapshots.create(candidate.n);
	yield* (yield* GenerationPreparation).prepare(snapshot.directory, snapshot.directory);
	yield* generations.setSnapshot(candidate.n, snapshot.directory);
	yield* sql`UPDATE generations SET backup_id=${record.backup} WHERE n=${candidate.n}`;
	const generation = { ...candidate, snapshot_dir: snapshot.directory, backup_id: record.backup };
	yield* Effect.scoped(
		Effect.gen(function* () {
			const temporary = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: ".restore-rehearsal-" });
			yield* (yield* storageHeadroom(root)).check(Number((yield* fs.stat(backupPath)).size));
			const clone = path.resolve(temporary, "app.db");
			yield* fs.copyFile(backupPath, clone);
			// Rehearsal never publishes its private sequence space into boot.
			const epoch = `restore-rehearsal-${record.proof_id}`;
			yield* backup.prepareClone(clone, epoch);
			const report = yield* Effect.acquireUseRelease(
				supervisor
					.launch(generation, { _tag: "file", filename: clone }, "rehearsal", (yield* events.state).next, epoch)
					.pipe(Effect.provideContext(context)),
				(rehearsed) =>
					rehearsed.process.health.pipe(
						Effect.timeout("30 seconds"),
						Effect.catch(() =>
							Ref.get(rehearsed.process.stderr).pipe(
								Effect.flatMap((stderr) => Effect.fail(new ChildError({ code: "restore_rehearsal_failed", stderr }))),
							),
						),
					),
				(rehearsed) => supervisor.retire(rehearsed).pipe(Effect.provideContext(context), Effect.orDie),
			);
			yield* generations.rehearsed(generation.n, report);
		}),
	);
	return generation;
}, Effect.scoped);
