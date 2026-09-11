import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { ChildError } from "./child-process.ts";
import { PreparationProcess } from "./preparation-process.ts";
import { copyPreparedTree, syncPreparedTree } from "./prepared-tree.ts";
import { copySource, SnapshotRejected } from "./snapshots.ts";

/** Prepares disposable install/build work before rehearsal. Accepted artifacts
 * are boot-owned copies, never links into the writable work cache. Same-UID
 * development is not an OS isolation boundary (SPEC §7.9 remains separate). */
export class GenerationPreparation extends Context.Service<
	GenerationPreparation,
	{
		readonly prepare: (
			sourceDirectory: string,
			snapshotDirectory: string,
		) => Effect.Effect<void, PlatformError | SnapshotRejected | ChildError>;
	}
>()("comms/boot/GenerationPreparation") {}

export const layer = (options: { readonly dataDirectory: string; readonly dependenciesDirectory?: string }) =>
	Layer.effect(
		GenerationPreparation,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const crypto = yield* Crypto.Crypto;
			const commands = yield* PreparationProcess;
			const gate = yield* Semaphore.make(1);
			const digest = (bytes: Uint8Array) =>
				crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
			const hash = (parts: ReadonlyArray<string>) =>
				digest(new TextEncoder().encode(parts.map((part) => `${part.length}:${part}`).join("")));
			const treeHash = Effect.fn("GenerationPreparation.treeHash")(function* (
				directory: string,
			): Effect.fn.Return<string, PlatformError | SnapshotRejected> {
				if ((yield* fs.realPath(directory)) !== directory)
					return yield* new SnapshotRejected({ path: directory, reason: "UI source symlinks are not allowed" });
				const info = yield* fs.stat(directory);
				if (info.type === "File")
					return yield* hash(["file", String(info.mode & 0o111), yield* digest(yield* fs.readFile(directory))]);
				if (info.type !== "Directory")
					return yield* new SnapshotRejected({ path: directory, reason: "UI source must be regular" });
				const children: Array<string> = [];
				for (const name of (yield* fs.readDirectory(directory)).sort()) {
					if (name === "node_modules" || name === ".vite") continue;
					children.push(name, yield* treeHash(path.join(directory, name)));
				}
				return yield* hash(["directory", ...children]);
			});
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
								const syncSnapshot = Effect.gen(function* () {
									yield* syncPreparedTree(snapshot);
									let ancestor = path.dirname(snapshot);
									while (true) {
										yield* (yield* fs.open(ancestor)).sync;
										if (ancestor === root) break;
										ancestor = path.dirname(ancestor);
									}
								});
								const runtime = [
									"preparation-v1",
									process.versions.bun ?? process.version,
									process.platform,
									process.arch,
								];
								const cache = path.join(root, "cache");
								const artifacts = path.join(root, "prepared");
								for (const directory of [
									cache,
									artifacts,
									path.join(artifacts, "dependencies"),
									path.join(artifacts, "ui"),
								])
									yield* fs.makeDirectory(directory, { recursive: true, mode: 0o750 });
								// Persist the new artifact-root links as well as each eventual promotion.
								for (const directory of [
									path.join(artifacts, "dependencies"),
									path.join(artifacts, "ui"),
									artifacts,
									root,
								])
									yield* (yield* fs.open(directory)).sync;
								const temporary = yield* fs.makeTempDirectoryScoped({ directory: cache, prefix: ".prepare-" });
								const prepareDependencies = Effect.fn("GenerationPreparation.dependencies")(function* (
									directory: string,
									allowDependencyFree = false,
								) {
									const manifestPath = path.join(directory, "package.json");
									const lockPath = path.join(directory, "bun.lock");
									const requireFile = (file: string) =>
										Effect.gen(function* () {
											if (
												!(yield* fs.exists(file)) ||
												(yield* fs.realPath(file)) !== file ||
												(yield* fs.stat(file)).type !== "File"
											)
												return yield* new SnapshotRejected({
													path: file,
													reason: "Runtime packages require regular package.json and bun.lock files",
												});
										});
									yield* requireFile(manifestPath);
									const manifest = yield* fs.readFile(manifestPath);
									if (allowDependencyFree) {
										const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
											new TextDecoder().decode(manifest),
										).pipe(
											Effect.mapError(
												() =>
													new SnapshotRejected({
														path: manifestPath,
														reason: "Extension package manifest must be a JSON object",
													}),
											),
										);
										// Bun removes empty dependency locks; these packages have nothing to install.
										if (
											![
												"dependencies",
												"devDependencies",
												"optionalDependencies",
												"peerDependencies",
												"bundledDependencies",
												"bundleDependencies",
												"workspaces",
												"overrides",
												"resolutions",
											].some((key) => key in parsed)
										)
											return undefined;
									}
									yield* requireFile(lockPath);
									const lockfile = yield* fs.readFile(lockPath);
									const dependenciesKey = yield* hash([...runtime, yield* digest(manifest), yield* digest(lockfile)]);
									const dependencies = path.join(artifacts, "dependencies", dependenciesKey);
									if (!(yield* fs.exists(dependencies))) {
										const install = yield* fs.makeTempDirectoryScoped({ directory: temporary, prefix: "install-" });
										yield* fs.writeFile(path.join(install, "package.json"), manifest);
										yield* fs.writeFile(path.join(install, "bun.lock"), lockfile);
										yield* commands.install(install);
										if (!(yield* fs.exists(path.join(install, "node_modules"))))
											yield* fs.makeDirectory(path.join(install, "node_modules"));
										const promotion = yield* fs.makeTempDirectoryScoped({
											directory: path.join(artifacts, "dependencies"),
											prefix: ".partial-",
										});
										yield* fs.makeDirectory(path.join(promotion, "artifact"));
										yield* copyPreparedTree(
											path.join(install, "node_modules"),
											path.join(promotion, "artifact/node_modules"),
										);
										yield* syncPreparedTree(path.join(promotion, "artifact"));
										yield* fs.rename(path.join(promotion, "artifact"), dependencies);
										yield* (yield* fs.open(path.dirname(dependencies))).sync;
									}
									return { dependenciesKey, dependencies, manifest };
								});
								const manifestExists = yield* fs.exists(path.join(source, "package.json"));
								const lockExists = yield* fs.exists(path.join(source, "bun.lock"));
								const rootPackage = yield* Effect.gen(function* () {
									if (!manifestExists && !lockExists && options.dependenciesDirectory !== undefined) {
										const dependencies = yield* fs.realPath(options.dependenciesDirectory);
										if ((yield* fs.stat(dependencies)).type !== "Directory")
											return yield* new SnapshotRejected({
												path: dependencies,
												reason: "Development dependencies must be a directory",
											});
										yield* fs.symlink(dependencies, path.join(snapshotDirectory, "node_modules"));
										return undefined;
									}
									const prepared = yield* prepareDependencies(source);
									if (prepared === undefined) return undefined;
									yield* fs.symlink(
										path.join(prepared.dependencies, "node_modules"),
										path.join(snapshotDirectory, "node_modules"),
									);
									return prepared;
								});
								const extensions = path.join(source, "ext");
								if (yield* fs.exists(extensions)) {
									if (
										(yield* fs.realPath(extensions)) !== extensions ||
										(yield* fs.stat(extensions)).type !== "Directory"
									)
										return yield* new SnapshotRejected({
											path: extensions,
											reason: "Extension source must be a regular directory",
										});
									for (const name of (yield* fs.readDirectory(extensions)).sort()) {
										const directory = path.join(extensions, name);
										if ((yield* fs.realPath(directory)) !== directory)
											return yield* new SnapshotRejected({
												path: directory,
												reason: "Extension source symlinks are not allowed",
											});
										if (
											(yield* fs.stat(directory)).type !== "Directory" ||
											!(yield* fs.exists(path.join(directory, "package.json"))) ||
											(yield* fs.stat(path.join(directory, "package.json"))).type !== "File"
										)
											continue;
										const prepared = yield* prepareDependencies(directory, true);
										if (prepared === undefined) continue;
										yield* fs.symlink(
											path.join(prepared.dependencies, "node_modules"),
											path.join(snapshotDirectory, "ext", name, "node_modules"),
										);
									}
								}
								if (rootPackage === undefined) {
									yield* syncSnapshot;
									return;
								}
								const { dependenciesKey, dependencies, manifest } = rootPackage;
								const ui = path.join(source, "ui");
								if (!(yield* fs.exists(ui))) {
									yield* syncSnapshot;
									return;
								}
								const uiKey = yield* hash([dependenciesKey, yield* treeHash(ui)]);
								const built = path.join(artifacts, "ui", uiKey);
								if (!(yield* fs.exists(built))) {
									const work = path.join(temporary, "build");
									yield* fs.makeDirectory(work);
									yield* copySource(ui, path.join(work, "ui"));
									yield* copyPreparedTree(path.join(dependencies, "node_modules"), path.join(work, "node_modules"));
									yield* fs.writeFile(path.join(work, "package.json"), manifest);
									const output = path.join(temporary, "board");
									yield* commands.build(work, output);
									const promotion = yield* fs.makeTempDirectoryScoped({
										directory: path.join(artifacts, "ui"),
										prefix: ".partial-",
									});
									yield* fs.makeDirectory(path.join(promotion, "artifact"));
									yield* copySource(output, path.join(promotion, "artifact/board"));
									if ((yield* fs.stat(path.join(promotion, "artifact/board/index.html"))).type !== "File")
										return yield* new SnapshotRejected({ path: output, reason: "UI build must produce index.html" });
									yield* syncPreparedTree(path.join(promotion, "artifact"));
									yield* fs.rename(path.join(promotion, "artifact"), built);
									yield* (yield* fs.open(path.dirname(built))).sync;
								}
								// Board's static handler deliberately refuses a symlink root.
								yield* fs.remove(path.join(snapshotDirectory, "board"), { recursive: true, force: true });
								yield* copySource(path.join(built, "board"), path.join(snapshotDirectory, "board"));
								yield* syncSnapshot;
							}).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path)),
						),
					),
			});
		}),
	);
