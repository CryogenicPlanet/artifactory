import { Context, Effect, FileSystem, Layer, Path, Schema, Crypto } from "effect";
import type { SourceRejected } from "./source-schema.ts";
import { sourceIO } from "./source-io.ts";
import { sourceTreeFingerprint } from "./source-tree-publication.ts";
import type { PlatformError } from "effect/PlatformError";

export class SnapshotRejected extends Schema.TaggedError<SnapshotRejected>()("SnapshotRejected", {
	path: Schema.String,
	reason: Schema.String,
}) {
	get message() {
		return `${this.reason}: ${this.path}`;
	}
}

export interface Snapshot {
	readonly generation: number;
	readonly directory: string;
}

/** Shared by initial seeding and generation snapshots; neither operation loads source. */
export const copySource = Effect.fn("copySource")(function* (sourceDirectory: string, destination: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const source = yield* fs.realPath(sourceDirectory);
	const parent = yield* fs.realPath(path.dirname(destination));
	const target = path.join(parent, path.basename(destination));
	const relativeTarget = path.relative(source, target);
	if (
		relativeTarget === "" ||
		(relativeTarget !== ".." && !relativeTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeTarget))
	) {
		return yield* new SnapshotRejected({ path: target, reason: "Source and destination must be separate" });
	}
	const copyTree = Effect.fn("copySource.tree")(function* (
		relative: string,
		to: string,
	): Effect.fn.Return<void, SnapshotRejected | PlatformError> {
		const from = path.join(source, relative);
		if ((yield* fs.realPath(from)) !== from) {
			return yield* new SnapshotRejected({ path: from, reason: "Source symlinks are not allowed" });
		}
		const info = yield* fs.stat(from);
		if (info.type === "File") {
			yield* fs.copyFile(from, to);
			yield* fs.chmod(to, (info.mode & 0o111) !== 0 ? 0o750 : 0o640);
		} else if (info.type === "Directory") {
			yield* fs.makeDirectory(to, { mode: 0o750 });
			for (const name of (yield* fs.readDirectory(from)).sort()) {
				const child = path.join(relative, name);
				if (name === "node_modules" || name === ".vite" || child === path.join("ui", "dist")) continue;
				yield* copyTree(child, path.join(to, name));
			}
		} else {
			return yield* new SnapshotRejected({
				path: from,
				reason: "Only regular files and directories may be snapshotted",
			});
		}
	});
	if ((yield* fs.stat(source)).type !== "Directory") {
		return yield* new SnapshotRejected({ path: source, reason: "Source must be a directory" });
	}
	yield* copyTree("", target);
});

/** Copies committed source without loading it; only a completed copy is returned.
 * The caller holds the edit lock; existing generation storage must be boot-owned. */
export class Snapshots extends Context.Service<
	Snapshots,
	{
		readonly create: (generation: number) => Effect.Effect<Snapshot, SnapshotRejected | PlatformError | SourceRejected>;
	}
>()("comms/boot/Snapshots") {}

export const layer = (options: { readonly sourceDirectory: string; readonly generationsDirectory: string }) =>
	Layer.effect(
		Snapshots,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const crypto = yield* Crypto.Crypto;
			const path = yield* Path.Path;
			const source = yield* fs.realPath(options.sourceDirectory);
			if ((yield* fs.stat(source)).type !== "Directory") {
				return yield* new SnapshotRejected({ path: source, reason: "Source must be a directory" });
			}
			const generations = yield* fs.realPath(options.generationsDirectory);
			const overlaps = (parent: string, child: string) => {
				const relative = path.relative(parent, child);
				return (
					relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
				);
			};
			if (overlaps(source, generations) || overlaps(generations, source)) {
				return yield* new SnapshotRejected({
					path: generations,
					reason: "Source and generation directories must be separate",
				});
			}

			return Snapshots.of({
				create: Effect.fn("Snapshots.create")(function* (generation) {
					if (!Number.isSafeInteger(generation) || generation < 1) {
						return yield* new SnapshotRejected({
							path: String(generation),
							reason: "Generation must be a positive safe integer",
						});
					}
					const reserved = path.join(generations, String(generation));
					// Exclusive mkdir prevents retries or concurrent callers from replacing a generation.
					yield* fs.makeDirectory(reserved, { mode: 0o750 });
					const partial = path.join(reserved, ".partial");
					const directory = path.join(reserved, "source");
					yield* copySource(source, partial).pipe(
						Effect.provideService(FileSystem.FileSystem, fs),
						Effect.provideService(Path.Path, path),
					);
					// A failure or interruption leaves only .partial; later retention can remove the reservation.
					yield* fs.rename(partial, directory);
					// New snapshots keep generated board output beside source. The marker proves
					// preparation has never overwritten editable board/ bytes in this snapshot.
					yield* Effect.scoped(
						Effect.gen(function* () {
							const metadata = yield* sourceIO(reserved).pipe(
								Effect.flatMap((io) => io.inventory(directory)),
								Effect.provideService(Crypto.Crypto, crypto),
								Effect.provideService(FileSystem.FileSystem, fs),
								Effect.provideService(Path.Path, path),
							);
							const marker = yield* fs.open(`${directory}.editable`, { flag: "wx", mode: 0o640 });
							yield* marker.writeAll(new TextEncoder().encode(sourceTreeFingerprint(metadata)));
							yield* marker.sync;
							yield* (yield* fs.open(reserved)).sync;
						}),
					);
					return { generation, directory };
				}),
			});
		}),
	);
