import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { validSourcePath } from "./source-io.ts";
import { SourceRejected, type Write } from "./source-schema.ts";

/** Inventory editable bytes only; generated dependencies/build caches are not source.
 * The caller chooses an authoritative root. Every traversed component must be literal. */
export const readSourceInventory = Effect.fn("readSourceInventory")(function* (
	directory: string,
): Effect.fn.Return<
	{ readonly files: readonly Write[]; readonly directories: readonly string[] },
	SourceRejected | PlatformError,
	FileSystem.FileSystem | Path.Path
> {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const absoluteRoot = path.resolve(directory);
	const root = path.join(yield* fs.realPath(path.dirname(absoluteRoot)), path.basename(absoluteRoot));
	const files: Write[] = [];
	const directories: string[] = [];
	const visit = Effect.fn("readSourceTree.entry")(function* (
		relative: string,
	): Effect.fn.Return<void, SourceRejected | PlatformError> {
		const absolute = path.join(root, relative);
		if ((yield* fs.realPath(absolute)) !== absolute)
			return yield* new SourceRejected({ code: "invalid_path", path: `app/${relative}` });
		const info = yield* fs.stat(absolute);
		if (info.type === "File" && relative !== "") {
			files.push({ path: `app/${relative}`, content: yield* fs.readFile(absolute), mode: info.mode & 0o777 });
			return;
		}
		if (info.type !== "Directory") return yield* new SourceRejected({ code: "invalid_path", path: `app/${relative}` });
		directories.push(relative === "" ? "app" : `app/${relative}`);
		for (const name of (yield* fs.readDirectory(absolute)).sort()) {
			const child = relative === "" ? name : `${relative}/${name}`;
			if (name === "node_modules" || name === ".vite" || name.startsWith(".comms-") || child === "ui/dist") continue;
			if (!validSourcePath(`app/${child}`))
				return yield* new SourceRejected({ code: "invalid_path", path: `app/${child}` });
			yield* visit(child);
		}
	});
	yield* visit("");
	return { files, directories };
});
