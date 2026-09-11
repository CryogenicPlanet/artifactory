import { Config, Crypto, Effect, FileSystem, Path } from "effect";
import { sourceTreeIO } from "./source-tree-publication.ts";
import { SourceRejected, type Image } from "./source-schema.ts";

export const validSourcePath = (name: string) => {
	const parts = name.split("/");
	return (
		(parts[0] === "app" || parts[0] === "pages") &&
		parts.length > 1 &&
		!/[\\:]/.test(name) &&
		Array.from(name).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
		parts.every(
			(part) =>
				part !== "" &&
				part !== "." &&
				part !== ".." &&
				part !== "node_modules" &&
				part !== ".vite" &&
				!part.startsWith(".comms-"),
		) &&
		!(parts[0] === "app" && parts[1] === "ui" && parts[2] === "dist")
	);
};
export const sameImage = (a: Image, b: Image) =>
	a.sha === b.sha && a.mode === b.mode && (a.directory === true) === (b.directory === true);

/** Platform IO bound to one editable data root. Nothing is resolved during construction. */
export const sourceIO = Effect.fn("sourceIO")(function* (dataDirectory: string) {
	const isolated = yield* Config.Boolean("COMMS_ISOLATED").pipe(Config.withDefault(false), Effect.orDie);
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const image = Effect.fn("sourceIO.image")(function* (content: Uint8Array | null, mode: number | null) {
		return {
			content,
			mode: content === null ? null : (mode ?? 0o640),
			sha: content === null ? null : Buffer.from(yield* crypto.digest("SHA-256", content)).toString("hex"),
		};
	});
	const sync = (directory: string) =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* (yield* fs.open(directory)).sync;
			}),
		);
	const resolve = Effect.fn("sourceIO.resolve")(function* (
		name: string,
		createParents = false,
		allowDirectory = false,
	) {
		if (!validSourcePath(name) && !(allowDirectory && (name === "app" || name === "pages")))
			return yield* new SourceRejected({ code: "invalid_path", path: name });
		const root = yield* fs.realPath(dataDirectory);
		const parts = name.split("/");
		let parent = root;
		let type: "File" | "Directory" | null = null;
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index];
			if (part === undefined) return yield* Effect.die("Missing source path segment");
			const entry = path.join(parent, part);
			const exists = (yield* fs.readDirectory(parent)).includes(part);
			if (!exists) {
				// Case/Unicode aliases are existing entries even when the directory spelling differs.
				if ((yield* fs.exists(entry)) || (yield* fs.readLink(entry).pipe(Effect.result))._tag === "Success")
					return yield* new SourceRejected({ code: "invalid_path", path: name });
				if (index === parts.length - 1 || !createParents)
					return { absolute: path.join(root, name), exists: false, type: null };
				yield* fs.makeDirectory(entry, { mode: isolated && parts[0] === "pages" ? 0o2770 : 0o750 });
			} else {
				if (
					(yield* fs
						.realPath(entry)
						.pipe(Effect.mapError(() => new SourceRejected({ code: "invalid_path", path: name })))) !== entry
				)
					return yield* new SourceRejected({ code: "invalid_path", path: name });
				const info = yield* fs.stat(entry);
				if (
					info.type !== (index === parts.length - 1 ? "File" : "Directory") &&
					!(allowDirectory && index === parts.length - 1 && info.type === "Directory")
				)
					return yield* new SourceRejected({ code: "invalid_path", path: name });
				if (info.type === "File" || info.type === "Directory") type = info.type;
			}
			if (createParents && index < parts.length - 1) {
				yield* sync(entry);
				yield* sync(parent);
			}
			parent = entry;
		}
		return { absolute: parent, exists: true, type };
	});
	const list = Effect.fn("sourceIO.list")(function* (name: string) {
		const target = yield* resolve(name, false, true);
		if (target.type !== "Directory") return null;
		const items: { readonly name: string; readonly type: "file" | "directory" }[] = [];
		for (const entry of yield* fs.readDirectory(target.absolute)) {
			const child = `${name}/${entry}`;
			if (!validSourcePath(child)) continue;
			const resolved = yield* resolve(child, false, true).pipe(
				Effect.catchTag("SourceRejected", () => Effect.succeed(null)),
			);
			if (resolved?.type === "File" || resolved?.type === "Directory")
				items.push({ name: entry, type: resolved.type === "File" ? "file" : "directory" });
		}
		return items;
	});
	const read = Effect.fn("sourceIO.read")(function* (name: string) {
		const target = yield* resolve(name);
		if (!target.exists) return yield* image(null, null);
		const info = yield* fs.stat(target.absolute);
		return yield* image(yield* fs.readFile(target.absolute), info.mode & 0o777);
	});
	const replace = Effect.fn("sourceIO.replace")(function* (name: string, desired: Image, temporaryId: string) {
		const target = yield* resolve(name, desired.content !== null);
		const parent = path.dirname(target.absolute);
		if (desired.content === null) {
			if (target.exists) yield* fs.remove(target.absolute);
			// A prior crash may have already unlinked the file; synchronize that removal too.
			if (yield* fs.exists(parent)) yield* sync(parent);
			return;
		}
		const temporary = path.join(parent, `.comms-${temporaryId}.tmp`);
		// This name belongs to the durable journal, including incomplete writes left by process death.
		if ((yield* fs.readDirectory(parent)).includes(path.basename(temporary))) {
			if ((yield* fs.realPath(temporary)) !== temporary || (yield* fs.stat(temporary)).type !== "File")
				return yield* new SourceRejected({ code: "external_conflict", path: name });
			yield* fs.remove(temporary);
		}
		yield* Effect.scoped(
			Effect.gen(function* () {
				const handle = yield* fs.open(temporary, { flag: "wx", mode: desired.mode ?? 0o640 });
				yield* Effect.addFinalizer(() => fs.remove(temporary, { force: true }).pipe(Effect.orDie));
				yield* handle.writeAll(desired.content ?? new Uint8Array());
				yield* fs.chmod(temporary, desired.mode ?? 0o640);
				yield* handle.sync;
				yield* fs.rename(temporary, target.absolute);
				yield* sync(parent);
			}),
		);
	});
	return { read, list, image, replace, resolve, ...(yield* sourceTreeIO(dataDirectory, validSourcePath)) };
});
