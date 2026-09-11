import { Effect, FileSystem, Path, Schema } from "effect";

class InvalidExtensionEntry extends Schema.TaggedError<InvalidExtensionEntry>()("InvalidExtensionEntry", {
	path: Schema.String,
}) {
	get message() {
		return `Extension entry must be a regular file inside its snapshot: ${this.path}`;
	}
}

/** Discovery never installs dependencies or follows source symlinks. Imports remain optional failures. */
export const discoverExtensions = Effect.fn("discoverExtensions")(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	if (!(yield* fs.exists(directory))) return [];
	const root = yield* fs.realPath(directory);
	const entries: {
		readonly name: string;
		readonly file: string;
		readonly core: boolean;
		readonly manifest: string | null;
	}[] = [];
	for (const name of yield* fs.readDirectory(root)) {
		if (name === "node_modules") continue;
		const absolute = path.join(root, name);
		if ((yield* fs.readLink(absolute).pipe(Effect.result))._tag === "Success") continue;
		if ((yield* fs.realPath(absolute)) !== absolute) continue;
		const info = yield* fs.stat(absolute);
		if (info.type === "File" && /\.(ts|js)$/.test(name)) {
			entries.push({ name, file: absolute, core: /^core\.(ts|js)$/.test(name), manifest: null });
		} else if (info.type === "Directory") {
			const manifest = path.join(absolute, "package.json");
			if (
				(yield* fs.exists(manifest)) &&
				(yield* fs.realPath(manifest)) === manifest &&
				(yield* fs.stat(manifest)).type === "File"
			)
				entries.push({ name, file: path.join(absolute, "index.ts"), core: false, manifest });
		}
	}
	return entries
		.sort((a, b) => Number(b.core) - Number(a.core) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map(({ name, file, manifest }) => ({
			name,
			path: Effect.gen(function* () {
				if (manifest !== null)
					yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(yield* fs.readFileString(manifest));
				if ((yield* fs.realPath(file)) !== file || (yield* fs.stat(file)).type !== "File")
					return yield* new InvalidExtensionEntry({ path: file });
				return file;
			}),
		}));
});
