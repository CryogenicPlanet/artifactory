import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SnapshotRejected } from "./snapshots.ts";

/** Copies installed package links without letting them escape the installed tree.
 * Writable build workspaces and promoted artifacts never share file inodes. */
export const copyPreparedTree = Effect.fn("copyPreparedTree")(function* (from: string, to: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.realPath(from);
	const copy = Effect.fn("copyPreparedTree.entry")(function* (
		source: string,
		target: string,
	): Effect.fn.Return<void, PlatformError | SnapshotRejected> {
		const link = yield* fs.readLink(source).pipe(Effect.result);
		if (link._tag === "Success") {
			const resolved = yield* fs.realPath(source);
			const relative = path.relative(root, resolved);
			if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
				return yield* new SnapshotRejected({ path: source, reason: "Prepared artifact link escapes its tree" });
			yield* fs.symlink(path.relative(path.dirname(target), path.join(to, relative)), target);
			return;
		}
		const info = yield* fs.stat(source);
		if (info.type === "Directory") {
			yield* fs.makeDirectory(target, { mode: 0o750 });
			for (const name of (yield* fs.readDirectory(source)).sort())
				yield* copy(path.join(source, name), path.join(target, name));
		} else if (info.type === "File") {
			yield* fs.copyFile(source, target);
			yield* fs.chmod(target, info.mode & 0o111 ? 0o750 : 0o640);
		} else
			return yield* new SnapshotRejected({ path: source, reason: "Prepared artifact must be a file or directory" });
	});
	yield* copy(root, to);
});

/** Sync copied bytes and directory entries before an artifact is promoted. */
export const syncPreparedTree = Effect.fn("syncPreparedTree")(function* (
	root: string,
): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem | Path.Path> {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	if ((yield* fs.readLink(root).pipe(Effect.result))._tag === "Success") return;
	if ((yield* fs.stat(root)).type === "Directory") {
		for (const name of yield* fs.readDirectory(root)) yield* syncPreparedTree(path.join(root, name));
	}
	yield* Effect.scoped(
		Effect.gen(function* () {
			yield* (yield* fs.open(root)).sync;
		}),
	);
});
