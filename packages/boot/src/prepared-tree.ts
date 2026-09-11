import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { storageHeadroom, type StorageRejected } from "./storage-headroom.ts";
import { SnapshotRejected } from "./snapshots.ts";

/** Copies installed package links, including isolated editable workspace packages.
 * Disposable build dependencies and retained generations never share file inodes. */
export const copyPreparedTree = Effect.fn("copyPreparedTree")(function* (from: string, to: string, workspace?: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.realPath(from);
	const headroom = yield* storageHeadroom(path.dirname(to));
	const volume = yield* headroom.sample;
	yield* headroom.reserve(volume);
	const workspaceRoot = workspace === undefined ? root : yield* fs.realPath(workspace);
	const inside = (parent: string, child: string) => {
		const relative = path.relative(parent, child);
		return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	};
	let copiedBytes = 0;
	const workspaces: { readonly source: string; readonly target: string }[] = [];
	const workspaceFiles: { readonly source: string; readonly target: string }[] = [];
	const copy = Effect.fn("copyPreparedTree.entry")(function* (
		source: string,
		target: string,
		ancestors: readonly string[],
	): Effect.fn.Return<void, PlatformError | SnapshotRejected | StorageRejected> {
		const link = yield* fs.readLink(source).pipe(Effect.result);
		if (link._tag === "Success") {
			const resolved = yield* fs.realPath(source);
			const relative = path.relative(root, resolved);
			if (!inside(workspaceRoot, resolved))
				return yield* new SnapshotRejected({ path: source, reason: "Prepared artifact link escapes its tree" });
			if (inside(root, resolved)) {
				yield* fs.symlink(path.relative(path.dirname(target), path.join(to, relative)), target);
			} else if ((yield* fs.stat(resolved)).type === "Directory") {
				// Dereference workspaces before build code runs; never retain links to disposable source.
				workspaces.push({ source: resolved, target });
				yield* copy(resolved, target, ancestors);
			} else {
				// Workspace bins must retain their package-relative imports. Resolve after
				// directories are copied because .bin commonly sorts before package names.
				workspaceFiles.push({ source: resolved, target });
			}
			return;
		}
		const info = yield* fs.stat(source);
		if (info.type === "Directory") {
			if (ancestors.includes(source))
				return yield* new SnapshotRejected({ path: source, reason: "Prepared workspace link is cyclic" });
			yield* fs.makeDirectory(target, { mode: 0o750 });
			for (const name of (yield* fs.readDirectory(source)).sort())
				yield* copy(path.join(source, name), path.join(target, name), [...ancestors, source]);
		} else if (info.type === "File") {
			copiedBytes += Number(info.size);
			yield* headroom.reserve(volume, copiedBytes);
			yield* fs.copyFile(source, target);
			yield* fs.chmod(target, info.mode & 0o111 ? 0o750 : 0o640);
		} else
			return yield* new SnapshotRejected({ path: source, reason: "Prepared artifact must be a file or directory" });
	});
	yield* copy(root, to, []);
	for (const file of workspaceFiles) {
		const workspace = workspaces.find((entry) => inside(entry.source, file.source));
		if (workspace === undefined)
			return yield* new SnapshotRejected({
				path: file.source,
				reason: "Prepared workspace file has no retained package",
			});
		yield* fs.symlink(
			path.relative(
				path.dirname(file.target),
				path.join(workspace.target, path.relative(workspace.source, file.source)),
			),
			file.target,
		);
	}
});

/** Sync copied bytes and directory entries before a generation is published. */
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
