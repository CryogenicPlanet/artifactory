import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { layer, Snapshots } from "../src/snapshots.ts";

const platform = Layer.merge(BunFileSystem.layer, Path.layer);
const fixture = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.makeTempDirectoryScoped();
	const sourceDirectory = path.join(root, "app");
	const generationsDirectory = path.join(root, "gen");
	yield* fs.makeDirectory(sourceDirectory);
	yield* fs.makeDirectory(generationsDirectory);
	return { fs, path, root, sourceDirectory, generationsDirectory };
});

describe("source snapshots", () => {
	it.effect("copies nested source without executing it and excludes derived directories", () => {
		return Effect.scoped(
			Effect.gen(function* () {
				const env = yield* fixture;
				const { fs, path, sourceDirectory } = env;
				for (const directory of ["kernel", "ui/src", "ui/dist", ".vite", "ext/tool/node_modules"]) {
					yield* fs.makeDirectory(path.join(sourceDirectory, directory), { recursive: true });
					yield* fs.writeFileString(path.join(sourceDirectory, directory, "file.ts"), directory);
				}
				yield* fs.writeFileString(path.join(sourceDirectory, "main.ts"), 'throw new Error("never import me")');
				yield* fs.writeFileString(path.join(sourceDirectory, "run.sh"), "#!/bin/sh\necho hello");
				yield* fs.chmod(path.join(sourceDirectory, "run.sh"), 0o755);
				const service = yield* Snapshots.pipe(Effect.provide(layer(env)));
				const snapshot = yield* service.create(1);
				expect(snapshot.generation).toBe(1);
				expect((yield* fs.stat(path.join(snapshot.directory, "run.sh"))).mode & 0o777).toBe(0o750);
				expect(yield* fs.readFileString(path.join(snapshot.directory, "kernel/file.ts"))).toBe("kernel");
				expect(yield* fs.readFileString(path.join(snapshot.directory, "ui/src/file.ts"))).toBe("ui/src");
				for (const excluded of ["ui/dist", ".vite", "ext/tool/node_modules"]) {
					expect(yield* fs.exists(path.join(snapshot.directory, excluded))).toBe(false);
				}
				yield* fs.writeFileString(path.join(sourceDirectory, "kernel/file.ts"), "edited");
				expect(yield* fs.readFileString(path.join(snapshot.directory, "kernel/file.ts"))).toBe("kernel");
				expect((yield* fs.stat(path.join(snapshot.directory, "main.ts"))).mode & 0o777).toBe(0o640);
			}),
		).pipe(Effect.provide(platform));
	});

	it.effect("rejects source symlinks and leaves a failed copy unavailable", () => {
		return Effect.scoped(
			Effect.gen(function* () {
				const env = yield* fixture;
				const { fs, path, sourceDirectory, generationsDirectory, root } = env;
				yield* fs.writeFileString(path.join(sourceDirectory, "a.ts"), "valid source");
				yield* fs.writeFileString(path.join(root, "private"), "must not copy");
				yield* fs.symlink(path.join(root, "private"), path.join(sourceDirectory, "z.ts"));
				const service = yield* Snapshots.pipe(Effect.provide(layer(env)));
				expect(Exit.isFailure(yield* Effect.exit(service.create(1)))).toBe(true);
				expect(yield* fs.exists(path.join(generationsDirectory, "1/source"))).toBe(false);
				expect(yield* fs.readFileString(path.join(generationsDirectory, "1/.partial/a.ts"))).toBe("valid source");
				expect(yield* fs.exists(path.join(generationsDirectory, "1/.partial/z.ts"))).toBe(false);
				yield* fs.remove(path.join(sourceDirectory, "z.ts"));
				yield* fs.symlink(sourceDirectory, path.join(sourceDirectory, "loop"));
				expect(Exit.isFailure(yield* Effect.exit(service.create(2)))).toBe(true);
				yield* fs.remove(path.join(sourceDirectory, "loop"));
				expect(Exit.isFailure(yield* Effect.exit(service.create(1)))).toBe(true);
				expect((yield* service.create(3)).generation).toBe(3);
			}),
		).pipe(Effect.provide(platform));
	});

	it.effect("reserves generations exclusively even for concurrent creates and existing target symlinks", () => {
		return Effect.scoped(
			Effect.gen(function* () {
				const env = yield* fixture;
				const { fs, path, sourceDirectory, generationsDirectory } = env;
				yield* fs.writeFileString(path.join(sourceDirectory, "main.ts"), "original");
				const service = yield* Snapshots.pipe(Effect.provide(layer(env)));
				const results = yield* Effect.all([Effect.exit(service.create(1)), Effect.exit(service.create(1))], {
					concurrency: "unbounded",
				});
				expect(results.filter(Exit.isSuccess)).toHaveLength(1);
				expect(results.filter(Exit.isFailure)).toHaveLength(1);
				yield* fs.writeFileString(path.join(sourceDirectory, "main.ts"), "changed");
				expect(Exit.isFailure(yield* Effect.exit(service.create(1)))).toBe(true);
				expect(yield* fs.readFileString(path.join(generationsDirectory, "1/source/main.ts"))).toBe("original");
				yield* fs.symlink(sourceDirectory, path.join(generationsDirectory, "2"));
				expect(Exit.isFailure(yield* Effect.exit(service.create(2)))).toBe(true);
				expect(yield* fs.exists(path.join(sourceDirectory, ".partial"))).toBe(false);
			}),
		).pipe(Effect.provide(platform));
	});

	it.effect("rejects invalid generation numbers and overlapping storage roots", () => {
		return Effect.scoped(
			Effect.gen(function* () {
				const env = yield* fixture;
				const { fs, path, sourceDirectory, generationsDirectory } = env;
				const service = yield* Snapshots.pipe(Effect.provide(layer(env)));
				for (const generation of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
					expect(Exit.isFailure(yield* Effect.exit(service.create(generation)))).toBe(true);
				}
				expect(yield* fs.readDirectory(generationsDirectory)).toEqual([]);
				const nested = path.join(sourceDirectory, "gen");
				yield* fs.makeDirectory(nested);
				const alias = path.join(env.root, "alias");
				yield* fs.symlink(nested, alias);
				for (const directory of [sourceDirectory, nested, alias, path.join(sourceDirectory, "missing/gen")]) {
					expect(
						Exit.isFailure(
							yield* Effect.exit(
								Snapshots.pipe(Effect.provide(layer({ sourceDirectory, generationsDirectory: directory }))),
							),
						),
					).toBe(true);
				}
				expect(yield* fs.readDirectory(sourceDirectory)).toEqual(["gen"]);
			}),
		).pipe(Effect.provide(platform));
	});

	it.effect("never publishes a copy interrupted between files", () => {
		return Effect.scoped(
			Effect.gen(function* () {
				const env = yield* fixture;
				const { fs, path, sourceDirectory, generationsDirectory } = env;
				yield* fs.writeFileString(path.join(sourceDirectory, "main.ts"), "source");
				const started = yield* Deferred.make<void>();
				const blockedFs = FileSystem.FileSystem.of({
					...fs,
					copyFile: () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(started, undefined);
							return yield* Effect.never;
						}),
				});
				const service = yield* Snapshots.pipe(
					Effect.provide(layer(env)),
					Effect.provideService(FileSystem.FileSystem, blockedFs),
				);
				const copying = yield* Effect.forkChild(service.create(1));
				yield* Deferred.await(started);
				yield* Fiber.interrupt(copying);
				expect(yield* fs.exists(path.join(generationsDirectory, "1/source"))).toBe(false);
				expect(yield* fs.readFileString(path.join(sourceDirectory, "main.ts"))).toBe("source");
			}),
		).pipe(Effect.provide(platform));
	});
});
