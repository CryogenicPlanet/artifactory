import { Crypto, Effect, FileSystem, Path } from "effect";
import type { ApplicationSource } from "./application.ts";
import { copySource, SnapshotRejected } from "./snapshots.ts";
import { sourceIO } from "./source-io.ts";
import { sourceTreeFingerprint } from "./source-tree-publication.ts";

/** Capture image-owned editable source once; the proof and proposal use these exact normalized bytes. */
export const seedSource = Effect.fn("seedSource")(function* (options: ApplicationSource) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const source = path.resolve(options.seedDirectory);
	const data = yield* fs.realPath(options.dataDirectory);
	if ((yield* fs.realPath(source)) !== source || source === data || source.startsWith(`${data}${path.sep}`))
		return yield* new SnapshotRejected({ path: source, reason: "Reset seed must be outside editable data" });
	const temporary = yield* fs.makeTempDirectoryScoped({ directory: data, prefix: ".reset-seed-" });
	const directory = path.join(temporary, "app");
	yield* copySource(source, directory);
	const entry = options.entryFile;
	if (path.isAbsolute(entry) || entry.split(/[\\/]/).some((part) => part === "" || part === "." || part === ".."))
		return yield* new SnapshotRejected({ path: entry, reason: "Invalid reset seed entry" });
	const entryPath = path.join(directory, entry);
	if ((yield* fs.stat(entryPath)).type !== "File")
		return yield* new SnapshotRejected({ path: entry, reason: "Reset seed entry must be a regular file" });
	const inventory = yield* (yield* sourceIO(data)).inventory(directory);
	const digest = Buffer.from(
		yield* crypto.digest("SHA-256", new TextEncoder().encode(sourceTreeFingerprint(inventory))),
	).toString("hex");
	return { directory, digest };
});
