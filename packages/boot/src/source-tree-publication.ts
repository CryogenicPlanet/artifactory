// oxlint-disable-next-line effecttsgo/node-builtin-import -- Atomic empty-directory removal is not provided by Effect FileSystem.remove.
import { rmdir } from "node:fs/promises";
import { Crypto, Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SourceRejected, type Change, type Image } from "./source-schema.ts";

export interface TreeEntry {
	readonly path: string;
	readonly image: Image;
}
/** Retained metadata detects missing or altered snapshot entries without duplicating source bytes. */
export const sourceTreeFingerprint = (entries: readonly TreeEntry[]) =>
	`1\n${JSON.stringify(entries.map(({ path, image }) => [path, image.sha, image.mode, image.directory === true]))}\n`;
const absent: Image = { content: null, sha: null, mode: null };
const exists = (image: Image) => image.directory === true || image.content !== null;
const equal = (a: Image, b: Image) =>
	a.sha === b.sha && a.mode === b.mode && (a.directory === true) === (b.directory === true);
const depth = (name: string) => name.split("/").length;

/** A full editable tree journal owns every entry, including empty directories. */
export const sourceTreeIO = Effect.fn("sourceTreeIO")(function* (
	dataDirectory: string,
	valid: (name: string) => boolean,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const sync = (name: string) =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* (yield* fs.open(name)).sync;
			}),
		);
	const scan = Effect.fn("sourceTreeIO.inventory")(function* (
		sourceDirectory?: string,
		temporaryPaths: readonly string[] = [],
	) {
		const dataRoot = yield* fs.realPath(dataDirectory);
		const root = sourceDirectory ?? path.join(dataRoot, "app");
		const entries: TreeEntry[] = [];
		const walk = Effect.fn("sourceTreeIO.walk")(function* (
			name: string,
		): Effect.fn.Return<void, PlatformError | SourceRejected> {
			if (name !== "app" && !valid(name)) return yield* new SourceRejected({ code: "invalid_path", path: name });
			const absolute = name === "app" ? root : path.join(root, name.slice(4));
			if ((yield* fs.realPath(absolute)) !== absolute)
				return yield* new SourceRejected({ code: "external_conflict", path: name });
			const info = yield* fs.stat(absolute);
			if (info.type === "Directory") {
				entries.push({ path: name, image: { ...absent, directory: true } });
				for (const child of (yield* fs.readDirectory(absolute)).sort()) {
					const childPath = `${name}/${child}`;
					// Runtime preparation adds dependency links; these and build caches are not editable source.
					if (child === "node_modules" || child === ".vite" || childPath === "app/ui/dist") continue;
					if (temporaryPaths.includes(childPath)) {
						const file = path.join(absolute, child);
						if ((yield* fs.realPath(file)) !== file || (yield* fs.stat(file)).type !== "File")
							return yield* new SourceRejected({ code: "external_conflict", path: childPath });
						continue;
					}
					yield* walk(`${name}/${child}`);
				}
			} else if (info.type === "File") {
				const content = yield* fs.readFile(absolute);
				entries.push({
					path: name,
					image: {
						content,
						mode: info.mode & 0o777,
						sha: Buffer.from(yield* crypto.digest("SHA-256", content)).toString("hex"),
					},
				});
			} else return yield* new SourceRejected({ code: "external_conflict", path: name });
		});
		const names = yield* fs.readDirectory(path.dirname(root));
		if (names.includes(path.basename(root))) yield* walk("app");
		else if ((yield* fs.exists(root)) || (yield* fs.readLink(root).pipe(Effect.result))._tag === "Success")
			return yield* new SourceRejected({ code: "external_conflict", path: "app" });
		return entries;
	});
	const inventory = (sourceDirectory?: string) => scan(sourceDirectory);
	const publishTree = Effect.fn("sourceTreeIO.publishTree")(function* (changes: readonly Change[], id: string) {
		const root = yield* fs.realPath(dataDirectory);
		const planned = new Map(changes.map((change) => [change.path, change]));
		const desiredRoot = planned.get("app")?.desired;
		if (planned.size !== changes.length || desiredRoot === undefined || desiredRoot.content !== null)
			return yield* new SourceRejected({ code: "path_conflict", path: "app" });
		for (const change of changes) {
			if (change.path !== "app" && (!valid(change.path) || !change.path.startsWith("app/")))
				return yield* new SourceRejected({ code: "invalid_path", path: change.path });
			if (change.path !== "app" && exists(change.desired) && !planned.get(path.dirname(change.path))?.desired.directory)
				return yield* new SourceRejected({ code: "path_conflict", path: change.path });
		}
		// Probe names on the actual filesystem before changing any editable entry.
		yield* Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: ".tree-paths-" });
				for (const change of [...changes].sort((a, b) => depth(a.path) - depth(b.path))) {
					if (!exists(change.desired)) continue;
					const target = path.join(directory, change.path);
					if (change.desired.directory) yield* fs.makeDirectory(target);
					else yield* fs.writeFileString(target, "", { flag: "wx" });
				}
			}).pipe(Effect.mapError(() => new SourceRejected({ code: "path_conflict", path: "app" }))),
		);
		const temporaryPaths = changes.flatMap((change, index) =>
			change.desired.content === null ? [] : [`${path.dirname(change.path)}/.comms-${id}-${index}.tmp`],
		);
		const removable = (change: Change) =>
			exists(change.before) && (!exists(change.desired) || change.before.directory !== change.desired.directory);
		const validate = Effect.fn("sourceTreeIO.validate")(function* (final = false) {
			const observed = new Map((yield* scan(undefined, temporaryPaths)).map((entry) => [entry.path, entry.image]));
			for (const name of observed.keys())
				if (!planned.has(name)) return yield* new SourceRejected({ code: "external_conflict", path: name });
			for (const change of changes) {
				const current = observed.get(change.path) ?? absent;
				const intermediate = !exists(current) && removable(change);
				if (!(equal(current, change.desired) || (!final && (equal(current, change.before) || intermediate))))
					return yield* new SourceRejected({ code: "external_conflict", path: change.path });
			}
			return observed;
		});
		yield* validate();
		for (const change of [...changes].sort((a, b) => depth(b.path) - depth(a.path) || b.path.localeCompare(a.path))) {
			if (!removable(change)) continue;
			const current = (yield* validate()).get(change.path) ?? absent;
			if (!exists(current) || equal(current, change.desired)) continue;
			const absolute = path.join(root, change.path);
			if (current.directory) {
				// Never recursively remove a directory: an unexpected child must survive and block recovery.
				if ((yield* fs.readDirectory(absolute)).length !== 0)
					return yield* new SourceRejected({ code: "external_conflict", path: change.path });
			}
			// Effect FileSystem.remove maps to rm, which cannot atomically remove only an empty directory.
			if (current.directory)
				yield* Effect.tryPromise({
					try: () => rmdir(absolute),
					catch: () => new SourceRejected({ code: "external_conflict", path: change.path }),
				});
			else yield* fs.remove(absolute);
			yield* sync(path.dirname(absolute));
		}
		for (const change of [...changes].sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))) {
			if (!change.desired.directory) continue;
			const observed = yield* validate();
			const absolute = path.join(root, change.path);
			if (!observed.has(change.path)) yield* fs.makeDirectory(absolute, { mode: 0o750 });
			yield* sync(absolute);
			yield* sync(path.dirname(absolute));
		}
		for (const [index, change] of changes.entries()) {
			if (change.desired.content === null) continue;
			yield* validate();
			const absolute = path.join(root, change.path);
			const temporary = path.join(path.dirname(absolute), `.comms-${id}-${index}.tmp`);
			if ((yield* fs.readDirectory(path.dirname(absolute))).includes(path.basename(temporary))) {
				if ((yield* fs.realPath(temporary)) !== temporary || (yield* fs.stat(temporary)).type !== "File")
					return yield* new SourceRejected({ code: "external_conflict", path: change.path });
				yield* fs.remove(temporary);
			}
			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* fs.open(temporary, { flag: "wx", mode: change.desired.mode ?? 0o640 });
					yield* Effect.addFinalizer(() => fs.remove(temporary, { force: true }).pipe(Effect.orDie));
					yield* handle.writeAll(change.desired.content ?? new Uint8Array());
					yield* fs.chmod(temporary, change.desired.mode ?? 0o640);
					yield* handle.sync;
					yield* fs.rename(temporary, absolute);
					yield* sync(path.dirname(absolute));
				}),
			);
		}
		yield* validate(true);
		// Re-sync the complete desired tree after a crash that happened after a mutation but before its parent sync.
		for (const change of changes) if (change.desired.directory) yield* sync(path.join(root, change.path));
		yield* sync(root);
	});
	return { inventory, publishTree };
});
