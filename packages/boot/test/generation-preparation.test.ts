import { BunServices } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Path, Ref } from "effect";
import { describe, expect } from "vitest";
import { GenerationPreparation, layer } from "../src/generation-preparation.ts";
import { PreparationProcess } from "../src/preparation-process.ts";

const fixture = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
	const source = path.join(root, "app");
	yield* fs.makeDirectory(path.join(source, "ui/public"), { recursive: true });
	yield* fs.writeFileString(
		path.join(source, "package.json"),
		'{"dependencies":{"vite":"8.0.0"},"comms":{"board_directory":"environment-v1"}}',
	);
	yield* fs.writeFileString(path.join(source, "bun.lock"), "lock-one");
	yield* fs.writeFileString(path.join(source, "ui/index.html"), "first");
	yield* fs.writeFileString(path.join(source, "ui/vite.config.ts"), "config-one");
	const installs = yield* Ref.make(0);
	const builds = yield* Ref.make(0);
	const commands = PreparationProcess.of({
		install: (workspace) =>
			Effect.gen(function* () {
				yield* Ref.update(installs, (n) => n + 1);
				expect((yield* fs.readDirectory(workspace)).sort()).toEqual(["bun.lock", "package.json"]);
				yield* fs.makeDirectory(path.join(workspace, "node_modules/pkg"), { recursive: true });
				yield* fs.writeFileString(path.join(workspace, "node_modules/pkg/index.js"), "installed");
				yield* fs.symlink("pkg", path.join(workspace, "node_modules/alias"));
			}).pipe(Effect.orDie),
		build: (workspace, output) =>
			Effect.gen(function* () {
				yield* Ref.update(builds, (n) => n + 1);
				// A Vite config can write into its own working dependencies without poisoning the cache.
				yield* fs.writeFileString(path.join(workspace, "node_modules/pkg/index.js"), "build mutation");
				yield* fs.makeDirectory(output);
				yield* fs.copyFile(path.join(workspace, "ui/index.html"), path.join(output, "index.html"));
			}).pipe(Effect.orDie),
	});
	const service = yield* GenerationPreparation.pipe(
		Effect.provide(layer({ dataDirectory: root })),
		Effect.provideService(PreparationProcess, commands),
	);
	const prepare = (n: number) =>
		Effect.gen(function* () {
			const snapshot = path.join(root, `snapshot-${n}`);
			yield* fs.makeDirectory(path.join(snapshot, "board"), { recursive: true });
			yield* fs.writeFileString(path.join(snapshot, "board/source.txt"), "editable source");
			yield* service.prepare(source, snapshot);
			return snapshot;
		});
	return { fs, path, root, source, installs, builds, prepare, commands };
});

describe("generation preparation", () => {
	it.effect("reuses matching artifacts and copies board output while isolating working dependencies", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { fs, path, root, installs, builds, prepare } = yield* fixture;
				const first = yield* prepare(1);
				const second = yield* prepare(2);
				expect(yield* Ref.get(installs)).toBe(1);
				expect(yield* Ref.get(builds)).toBe(1);
				expect(yield* fs.readFileString(path.join(first, "board/source.txt"))).toBe("editable source");
				const dependencies = yield* fs.realPath(path.join(first, "node_modules"));
				expect(dependencies.startsWith(path.join(root, "prepared/dependencies"))).toBe(true);
				expect(yield* fs.readFileString(path.join(first, "node_modules/alias/index.js"))).toBe("installed");
				expect(yield* fs.realPath(`${first}.board`)).toBe(`${first}.board`);
				yield* fs.writeFileString(`${second}.board/index.html`, "changed");
				expect(yield* fs.readFileString(`${first}.board/index.html`)).toBe("first");
				expect(yield* fs.readDirectory(path.join(root, "cache"))).toEqual([]);
			}),
		).pipe(Effect.provide(BunServices.layer)),
	);

	it.effect("invalidates builds for index, configuration, public files and lock-only edits", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { fs, path, source, installs, builds, prepare } = yield* fixture;
				yield* prepare(1);
				for (const [index, file] of [
					"ui/index.html",
					"ui/vite.config.ts",
					"ui/public/icon.svg",
					"bun.lock",
				].entries()) {
					yield* fs.writeFileString(path.join(source, file), `changed-${index}`);
					yield* prepare(index + 2);
				}
				expect(yield* Ref.get(installs)).toBe(2);
				expect(yield* Ref.get(builds)).toBe(5);
			}),
		).pipe(Effect.provide(BunServices.layer)),
	);

	it.effect("supports a headless runtime manifest and hashes nested UI dist inputs", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { fs, path, source, builds, prepare } = yield* fixture;
				yield* fs.makeDirectory(path.join(source, "ui/src/ui/dist"), { recursive: true });
				yield* fs.writeFileString(path.join(source, "ui/src/ui/dist/value.ts"), "one");
				yield* prepare(1);
				yield* fs.writeFileString(path.join(source, "ui/src/ui/dist/value.ts"), "two");
				yield* prepare(2);
				expect(yield* Ref.get(builds)).toBe(2);
				yield* fs.remove(path.join(source, "ui"), { recursive: true });
				const headless = yield* prepare(3);
				expect(yield* fs.exists(path.join(headless, "node_modules/pkg/index.js"))).toBe(true);
				expect(yield* fs.exists(`${headless}.board`)).toBe(false);
				expect(yield* Ref.get(builds)).toBe(2);
			}),
		).pipe(Effect.provide(BunServices.layer)),
	);

	it.effect("refuses rebuilding a legacy UI until its child declares the board directory contract", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { fs, path, source, builds, prepare } = yield* fixture;
				yield* fs.writeFileString(path.join(source, "package.json"), '{"dependencies":{"vite":"8.0.0"}}');
				const result = yield* prepare(1).pipe(Effect.result);
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure") expect(String(result.failure)).toContain("board_directory_upgrade_required");
				expect(yield* Ref.get(builds)).toBe(0);
				expect(yield* fs.readFileString(path.join(source, "ui/index.html"))).toBe("first");
			}),
		).pipe(Effect.provide(BunServices.layer)),
	);

	it.effect("requires both manifest files and only permits the explicit legacy link", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { fs, path, root, source, prepare, commands } = yield* fixture;
				yield* fs.remove(path.join(source, "bun.lock"));
				expect((yield* prepare(1).pipe(Effect.result))._tag).toBe("Failure");
				yield* fs.remove(path.join(source, "package.json"));
				expect((yield* prepare(2).pipe(Effect.result))._tag).toBe("Failure");
				const dependencies = path.join(root, "legacy-dependencies");
				yield* fs.makeDirectory(dependencies);
				const service = yield* GenerationPreparation.pipe(
					Effect.provide(layer({ dataDirectory: root, dependenciesDirectory: dependencies })),
					Effect.provideService(PreparationProcess, commands),
				);
				yield* service.prepare(source, path.join(root, "snapshot-2"));
				expect(yield* fs.realPath(path.join(root, "snapshot-2/node_modules"))).toBe(dependencies);
			}),
		).pipe(Effect.provide(BunServices.layer)),
	);
});
