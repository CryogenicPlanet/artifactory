import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { expect } from "vitest";
import { readStorageAllocation } from "../src/storage-usage.ts";

const platform = Layer.merge(BunFileSystem.layer, Path.layer);

it.effect("counts allocated blocks once across hardlinks and never follows snapshot dependency links", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const temporary = yield* fs.makeTempDirectoryScoped();
			const root = yield* fs.realPath(temporary);
			for (const name of ["backups", "gen/1/source", "prepared/dependencies/a", "prepared/ui/b", ".backup-drill-test"])
				yield* fs.makeDirectory(path.join(root, name), { recursive: true });
			yield* fs.writeFile(path.join(root, "boot.db"), new Uint8Array(32_768));
			yield* fs.link(path.join(root, "boot.db"), path.join(root, "backups/shared.db"));
			yield* fs.writeFile(path.join(root, "prepared/dependencies/a/package.js"), new Uint8Array(16_384));
			yield* fs.symlink(path.join(root, "prepared/dependencies/a"), path.join(root, "gen/1/source/node_modules"));
			yield* fs.symlink(path.join(root, "missing"), path.join(root, "gen/1/source/dangling"));
			yield* fs.symlink(root, path.join(root, "gen/1/source/cycle"));
			yield* fs.writeFile(path.join(root, ".backup-drill-test/comms.db"), new Uint8Array(8192));
			const bytes = (name: string) =>
				fs.stat(path.join(root, name)).pipe(Effect.map((info) => Option.getOrThrow(info.blocks) * 512));
			const result = yield* readStorageAllocation(root);
			expect(result.every((item) => item.error === null)).toBe(true);
			expect(result.find((item) => item.category === "boot_database")?.bytes).toBe(yield* bytes("boot.db"));
			expect(result.find((item) => item.category === "backups")?.bytes).toBe(yield* bytes("backups"));
			expect(result.find((item) => item.category === "generations")?.bytes).toBe(
				(yield* bytes("gen")) + (yield* bytes("gen/1")) + (yield* bytes("gen/1/source")),
			);
			expect(result.find((item) => item.category === "prepared_dependencies")?.bytes).toBe(
				(yield* bytes("prepared/dependencies")) +
					(yield* bytes("prepared/dependencies/a")) +
					(yield* bytes("prepared/dependencies/a/package.js")),
			);
			expect(result.find((item) => item.category === "scratch")?.bytes).toBe(
				(yield* bytes(".backup-drill-test")) + (yield* bytes(".backup-drill-test/comms.db")),
			);
			expect(result.find((item) => item.category === "app_wal")?.bytes).toBe(0);
		}),
	).pipe(Effect.provide(platform)),
);

it.effect("reports unavailable allocation metadata and crossed mounts without inventing byte values", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
			yield* fs.writeFileString(path.join(root, "boot.db"), "boot bytes");
			yield* fs.makeDirectory(path.join(root, "backups"));
			const observedFs = FileSystem.FileSystem.of({
				...fs,
				stat: (name) =>
					fs
						.stat(name)
						.pipe(
							Effect.map((info) =>
								name.endsWith("boot.db")
									? { ...info, blocks: Option.none() }
									: name.endsWith("backups")
										? { ...info, dev: info.dev + 1 }
										: info,
							),
						),
			});
			const result = yield* readStorageAllocation(root).pipe(Effect.provideService(FileSystem.FileSystem, observedFs));
			expect(result.find((item) => item.category === "boot_database")).toEqual({
				category: "boot_database",
				bytes: null,
				error: "unsupported_metadata",
			});
			expect(result.find((item) => item.category === "backups")).toEqual({
				category: "backups",
				bytes: null,
				error: "different_volume",
			});
			expect(result.find((item) => item.category === "app_database")).toEqual({
				category: "app_database",
				bytes: 0,
				error: null,
			});
		}),
	).pipe(Effect.provide(platform)),
);
