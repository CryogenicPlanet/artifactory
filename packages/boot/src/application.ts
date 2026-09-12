import { on } from "@comms/storage/dialect";
import { Cause, Effect, FileSystem, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ChildError } from "./child-process.ts";
import { GenerationPreparation } from "./generation-preparation.ts";
import { SourceFiles } from "./source-files.ts";
import { Generations, type Generation } from "./generations.ts";
import { copySource, layer as snapshotsLayer, SnapshotRejected, Snapshots } from "./snapshots.ts";

export interface ApplicationSource {
	readonly dataDirectory: string;
	readonly seedDirectory: string;
	readonly seedPagesDirectory?: string;
	readonly entryFile: string;
	/** Local development dependency link. Not a production lockfile-keyed dependency store. */
	readonly dependenciesDirectory?: string;
}

export const snapshotEntry = Effect.fn("snapshotEntry")(function* (generation: Generation, dataDirectory: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const source = generation.snapshot_dir;
	const expected = path.join(yield* fs.realPath(dataDirectory), "gen", String(generation.n), "source");
	const relative = generation.entry_file;
	if (
		!source ||
		source !== expected ||
		path.isAbsolute(relative) ||
		relative.split(/[\\/]/).some((part) => part === ".." || part === "." || part === "")
	) {
		return yield* new SnapshotRejected({ path: source ?? "", reason: "Invalid stored snapshot or entry path" });
	}
	const entry = path.join(source, relative);
	if ((yield* fs.realPath(entry)) !== entry || (yield* fs.stat(entry)).type !== "File") {
		return yield* new SnapshotRejected({ path: entry, reason: "Snapshot entry must be a regular file" });
	}
	return entry;
});

/** Seeds only an absent editable tree. Every attempted new snapshot has a durable reservation. */
export const prepareGeneration = Effect.fn("prepareGeneration")(function* (options: ApplicationSource) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const generations = yield* Generations;
	const sources = yield* SourceFiles;
	const sql = yield* SqlClient.SqlClient;
	const existing = yield* generations.list;
	const good = existing.filter((generation) => generation.good === 1 && generation.snapshot_dir !== null);
	if (
		options.seedPagesDirectory &&
		(yield* sql`SELECT ${sql("key")} FROM settings WHERE ${sql("key")}='pages_seeded'`).length === 0
	) {
		const seed = sources.withCommitted(seedPages(options));
		// Optional first-time page seeding cannot veto recovery from an immutable healthy app snapshot.
		yield* good.length > 0
			? seed.pipe(Effect.catch((error) => Effect.logWarning("Page seeding deferred", error)))
			: seed;
	}
	if (good.length > 0) return good;
	const generation = yield* sources.withCommitted(generations.reserve(options.entryFile));
	const prepare = Effect.gen(function* () {
		const sourceDirectory = path.join(options.dataDirectory, "app");
		if (!(yield* fs.exists(sourceDirectory))) {
			if (yield* generations.appSeeded) {
				return yield* new SnapshotRejected({
					path: sourceDirectory,
					reason: "Editable source is missing; refusing to replace it with seed",
				});
			}
			yield* Effect.scoped(
				Effect.gen(function* () {
					const temporary = yield* fs.makeTempDirectoryScoped({ directory: options.dataDirectory, prefix: ".seed-" });
					const app = path.join(temporary, "app");
					yield* copySource(options.seedDirectory, app);
					// Persist before rename: an interrupted first seed must never silently replace edited state.
					yield* generations.markAppSeeded;
					yield* fs.rename(app, sourceDirectory);
				}),
			);
		}
		yield* generations.markAppSeeded;
		const generationsDirectory = path.join(options.dataDirectory, "gen");
		yield* fs.makeDirectory(generationsDirectory, { recursive: true, mode: 0o750 });
		const snapshots = yield* Snapshots.pipe(Effect.provide(snapshotsLayer({ sourceDirectory, generationsDirectory })));
		const snapshot = yield* snapshots.create(generation.n);
		yield* (yield* GenerationPreparation).prepare(snapshot.directory, snapshot.directory);
		yield* generations.setSnapshot(generation.n, snapshot.directory);
		return [{ ...generation, snapshot_dir: snapshot.directory }];
	});
	return yield* sources.withCommitted(prepare).pipe(
		Effect.tapCause((cause) => {
			const failure = Cause.findError(cause);
			const stderr =
				failure._tag === "Success" && Schema.is(ChildError)(failure.success) ? (failure.success.stderr ?? "") : "";
			return generations.failed(generation.n, Cause.pretty(cause), stderr);
		}),
	);
});

/** A durable intent prevents removed or interrupted page trees from being silently reseeded. */
export const seedPages = Effect.fn("seedPages")(function* (options: ApplicationSource) {
	if (!options.seedPagesDirectory) return;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const sql = yield* SqlClient.SqlClient;
	if ((yield* sql`SELECT ${sql("key")} FROM settings WHERE ${sql("key")}='pages_seeded'`).length > 0) return;
	const root = yield* fs.realPath(options.dataDirectory);
	const target = path.join(root, "pages");
	if ((yield* fs.readDirectory(root)).includes("pages")) {
		if ((yield* fs.realPath(target)) !== target || (yield* fs.stat(target)).type !== "Directory")
			return yield* new SnapshotRejected({ path: target, reason: "Pages root must be a regular directory" });
		yield* on(sql, {
			sqlite: () => sql`INSERT OR IGNORE INTO settings (${sql("key")},value) VALUES ('pages_seeded','1')`,
			pg: () => sql`INSERT INTO settings (${sql("key")},value) VALUES ('pages_seeded','1') ON CONFLICT DO NOTHING`,
			mysql: () =>
				sql`INSERT INTO settings (${sql("key")},value) VALUES ('pages_seeded','1') ON DUPLICATE KEY UPDATE value=value`,
		});
		return;
	}
	yield* Effect.scoped(
		Effect.gen(function* () {
			const temporary = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: ".pages-seed-" });
			const copied = path.join(temporary, "pages");
			yield* copySource(options.seedPagesDirectory ?? "", copied);
			// Commit intent before publication; an interrupted initialization requires explicit repair.
			yield* on(sql, {
				sqlite: () => sql`INSERT OR IGNORE INTO settings (${sql("key")},value) VALUES ('pages_seeded','1')`,
				pg: () => sql`INSERT INTO settings (${sql("key")},value) VALUES ('pages_seeded','1') ON CONFLICT DO NOTHING`,
				mysql: () =>
					sql`INSERT INTO settings (${sql("key")},value) VALUES ('pages_seeded','1') ON DUPLICATE KEY UPDATE value=value`,
			});
			yield* fs.rename(copied, target);
			yield* (yield* fs.open(root)).sync;
		}),
	);
});
