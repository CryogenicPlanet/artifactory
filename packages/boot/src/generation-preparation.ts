import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HeadroomPolicy, storageHeadroom, type StorageRejected } from "./storage-headroom.ts";
import type { PlatformError } from "effect/PlatformError";
import type { ChildError } from "./child-process.ts";
import { PreparationProcess } from "./preparation-process.ts";
import { copyPreparedTree, syncPreparedTree } from "./prepared-tree.ts";
import { copySource, SnapshotRejected } from "./snapshots.ts";

/** Runs fixed install/build commands before rehearsal, in disposable workspaces.
 * Each generation owns its copied dependencies and board; no preparation runs on restart. */
export class GenerationPreparation extends Context.Service<
	GenerationPreparation,
	{
		readonly prepare: (
			sourceDirectory: string,
			snapshotDirectory: string,
		) => Effect.Effect<void, PlatformError | SnapshotRejected | ChildError | StorageRejected>;
	}
>()("comms/boot/GenerationPreparation") {}

export const layer = (options: { readonly dataDirectory: string; readonly dependenciesDirectory?: string }) =>
	Layer.effect(
		GenerationPreparation,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const commands = yield* PreparationProcess;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const policy = yield* HeadroomPolicy;
			const headroom = yield* storageHeadroom(options.dataDirectory);
			const gate = yield* Semaphore.make(1);
			return GenerationPreparation.of({
				prepare: (sourceDirectory, snapshotDirectory) =>
					gate.withPermit(
						Effect.scoped(
							Effect.gen(function* () {
								const source = yield* fs.realPath(sourceDirectory);
								const root = yield* fs.realPath(options.dataDirectory);
								const snapshot = yield* fs.realPath(snapshotDirectory);
								const relative = path.relative(root, snapshot);
								if (
									relative === "" ||
									relative === ".." ||
									relative.startsWith(`..${path.sep}`) ||
									path.isAbsolute(relative)
								)
									return yield* new SnapshotRejected({
										path: snapshot,
										reason: "Prepared snapshot must be inside the data directory",
									});
								const manifestPath = path.join(source, "package.json");
								const lockPath = path.join(source, "bun.lock");
								const manifestExists = yield* fs.exists(manifestPath);
								const lockExists = yield* fs.exists(lockPath);
								if (!manifestExists && !lockExists && options.dependenciesDirectory !== undefined) {
									const dependencies = yield* fs.realPath(options.dependenciesDirectory);
									if ((yield* fs.stat(dependencies)).type !== "Directory")
										return yield* new SnapshotRejected({
											path: dependencies,
											reason: "Development dependencies must be a directory",
										});
									yield* fs.symlink(dependencies, path.join(snapshot, "node_modules"));
								} else {
									for (const file of [manifestPath, lockPath]) {
										if (
											!(yield* fs.exists(file)) ||
											(yield* fs.realPath(file)) !== file ||
											(yield* fs.stat(file)).type !== "File"
										)
											return yield* new SnapshotRejected({
												path: file,
												reason: "Runtime packages require regular package.json and bun.lock files",
											});
									}
									const manifest = yield* fs.readFileString(manifestPath);
									const ui = path.join(source, "ui");
									const hasUi = yield* fs.exists(ui);
									if (hasUi) {
										if ((yield* fs.realPath(ui)) !== ui || (yield* fs.stat(ui)).type !== "Directory")
											return yield* new SnapshotRejected({ path: ui, reason: "UI source must be a regular directory" });
										const capability = Schema.Struct({
											comms: Schema.Struct({ board_directory: Schema.Literal("environment-v1") }),
										});
										const supported = yield* Schema.decodeEffect(Schema.fromJsonString(capability))(manifest).pipe(
											Effect.result,
										);
										if (supported._tag === "Failure")
											return yield* new SnapshotRejected({
												path: manifestPath,
												reason:
													'board_directory_upgrade_required: update the child to read BOARD_DIRECTORY and declare comms.board_directory="environment-v1" in package.json before rebuilding UI',
											});
									}
									const cache = path.join(root, "cache");
									yield* fs.makeDirectory(cache, { recursive: true, mode: 0o750 });
									const work = yield* fs.makeTempDirectoryScoped({ directory: cache, prefix: ".prepare-" });
									yield* fs.writeFileString(path.join(work, "package.json"), manifest);
									yield* fs.copyFile(lockPath, path.join(work, "bun.lock"));
									yield* headroom.check();
									yield* commands.install(work);
									const dependencies = path.join(work, "node_modules");
									if (!(yield* fs.exists(dependencies))) yield* fs.makeDirectory(dependencies);
									// Copy before editable Vite runs: build mutations must not change runtime dependencies.
									yield* copyPreparedTree(dependencies, path.join(snapshot, "node_modules"));
									if (hasUi) {
										yield* copySource(ui, path.join(work, "ui"));
										const output = path.join(work, "board");
										yield* headroom.check();
										yield* commands.build(work, output);
										yield* copySource(output, `${snapshot}.board`);
										if ((yield* fs.stat(`${snapshot}.board/index.html`)).type !== "File")
											return yield* new SnapshotRejected({ path: output, reason: "UI build must produce index.html" });
										yield* syncPreparedTree(`${snapshot}.board`);
									}
								}
								yield* syncPreparedTree(snapshot);
								let ancestor = path.dirname(snapshot);
								while (true) {
									yield* (yield* fs.open(ancestor)).sync;
									if (ancestor === root) break;
									ancestor = path.dirname(ancestor);
								}
							}).pipe(
								Effect.provideService(HeadroomPolicy, policy),
								Effect.provideService(FileSystem.FileSystem, fs),
								Effect.provideService(Path.Path, path),
								Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
							),
						),
					),
			});
		}),
	);
