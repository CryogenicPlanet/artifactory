import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export class AppStoreLayoutError extends Schema.TaggedError<AppStoreLayoutError>()("AppStoreLayoutError", {
	code: Schema.Literals(["app_layout_invalid", "app_store_missing", "app_checkpoint_busy"]),
}) {
	override get message() {
		return this.code;
	}
}

/** Call only after prior child ownership is positively closed, before selecting any recovery store.
 * Root prepares store/ ownership; boot can change its own database's group to that shared group. */
export const migrateAppStore = Effect.fn("migrateAppStore")(function* (options: {
	readonly dataDirectory: string;
	readonly filename: string;
}) {
	const sql = yield* SqlClient.SqlClient;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = path.resolve(options.dataDirectory);
	const legacy = path.join(root, "comms.db");
	const filename = path.resolve(options.filename);
	if (filename !== path.join(root, "store", "comms.db"))
		return yield* new AppStoreLayoutError({ code: "app_layout_invalid" });
	const directory = path.dirname(filename);
	const canonical = yield* fs.realPath(root);
	if ((yield* fs.realPath(directory)) !== path.join(canonical, "store"))
		return yield* new AppStoreLayoutError({ code: "app_layout_invalid" });
	const directoryInfo = yield* fs.stat(directory);
	if (directoryInfo.type !== "Directory" || Option.isNone(directoryInfo.gid))
		return yield* new AppStoreLayoutError({ code: "app_layout_invalid" });
	const group = directoryInfo.gid.value;
	// readDirectory detects dangling links too; exists alone would treat them as missing.
	const regular = (name: string) =>
		Effect.gen(function* () {
			if (!(yield* fs.readDirectory(path.dirname(name))).includes(path.basename(name))) return false;
			if (
				(yield* fs.realPath(name)) !== path.join(yield* fs.realPath(path.dirname(name)), path.basename(name)) ||
				(yield* fs.stat(name)).type !== "File"
			)
				return yield* new AppStoreLayoutError({ code: "app_layout_invalid" });
			return true;
		});
	const sync = (name: string) => Effect.scoped(fs.open(name).pipe(Effect.flatMap((file) => file.sync)));
	const rows = yield* sql`SELECT value FROM settings WHERE key='app_store_layout'`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
	);
	const phase = rows[0]?.value;
	if (phase !== undefined && phase !== "moving" && phase !== "ready")
		return yield* new AppStoreLayoutError({ code: "app_layout_invalid" });
	const oldExists = yield* regular(legacy);
	const newExists = yield* regular(filename);
	const initialized = (yield* sql`SELECT value FROM settings WHERE key='app_store_initialized'`).length > 0;
	if ((oldExists && newExists) || (oldExists && phase === "ready") || (newExists && phase === undefined))
		return yield* new AppStoreLayoutError({ code: "app_layout_invalid" });
	for (const base of [legacy, filename]) {
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			if ((yield* regular(`${base}${suffix}`)) && !(base === legacy ? oldExists : newExists))
				return yield* new AppStoreLayoutError({ code: "app_layout_invalid" });
		}
	}
	if (!oldExists && !newExists) {
		if (initialized || phase === "moving") return yield* new AppStoreLayoutError({ code: "app_store_missing" });
		// Fresh installation: normal recovery creates the database, never this migration.
		yield* sql`INSERT INTO settings(key,value) VALUES('app_store_layout','ready') ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
		return;
	}
	if (phase === "ready") return;
	if (oldExists) {
		yield* sql`INSERT INTO settings(key,value) VALUES('app_store_layout','moving') ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
		yield* Effect.scoped(
			Effect.gen(function* () {
				const app = yield* SqlClient.SqlClient;
				yield* app`PRAGMA synchronous = FULL`;
				const result = yield* app`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Array(Schema.Struct({ busy: Schema.Int, log: Schema.Int, checkpointed: Schema.Int })),
						),
					),
				);
				if (result.length !== 1 || result[0]?.busy !== 0 || result[0].log !== result[0].checkpointed)
					return yield* new AppStoreLayoutError({ code: "app_checkpoint_busy" });
			}).pipe(Effect.provide(SqliteClient.layer({ filename: legacy, disableWAL: true }))),
		);
		yield* sync(legacy);
		// The checkpoint and handle closure precede removal. No committed WAL bytes are discarded.
		for (const suffix of ["-wal", "-shm", "-journal"]) yield* fs.remove(`${legacy}${suffix}`, { force: true });
		yield* sync(root);
		yield* fs.rename(legacy, filename);
	}
	// An interrupted rename resumes here without ever copying an older store over the selected one.
	const info = yield* fs.stat(filename);
	if (Option.isNone(info.uid)) return yield* new AppStoreLayoutError({ code: "app_layout_invalid" });
	yield* fs.chown(filename, info.uid.value, group);
	yield* fs.chmod(filename, 0o660);
	yield* sync(filename);
	yield* sync(directory);
	yield* sync(root);
	yield* sql`INSERT INTO settings(key,value) VALUES('app_store_layout','ready') ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
});
