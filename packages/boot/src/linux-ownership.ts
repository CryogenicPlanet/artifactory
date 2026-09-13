import { Redacted } from "effect";
import { childStore, parseDescriptor, render, StoreError } from "@comms/storage/store";
import type { PlatformError } from "effect/PlatformError";
import { Effect, FileSystem, Path } from "effect";
import type { ChildConfiguration } from "./keeper-configuration.ts";

/** Fixed image identities. Only immutable sudo keepers call these operations as root. */
export const childIdentity = [
	"--reuid=1001",
	"--regid=1003",
	"--clear-groups",
	"--no-new-privs",
	"--bounding-set=-all",
	"--inh-caps=-all",
	"--ambient-caps=-all",
] as const;
export const buildIdentity = [
	"--reuid=1002",
	"--regid=1002",
	"--clear-groups",
	"--no-new-privs",
	"--bounding-set=-all",
	"--inh-caps=-all",
	"--ambient-caps=-all",
] as const;

const regular = Effect.fn("ownership.regular")(function* (filename: string) {
	const fs = yield* FileSystem.FileSystem;
	if ((yield* fs.realPath(filename)) !== filename) return yield* Effect.die("Ownership path must be canonical");
	return yield* fs.stat(filename);
});

/** Never follows a link while changing ownership. Published dependency links remain relative. */
export const ownTree = Effect.fn("ownership.tree")(function* (
	root: string,
	uid: number,
	gid: number,
	shared: boolean,
): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem | Path.Path> {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const real = yield* fs.realPath(root);
	if (real !== root) return;
	const stat = yield* fs.stat(root);
	if (stat.type !== "File" && stat.type !== "Directory")
		return yield* Effect.die("Ownership tree contains a special file");
	yield* fs.chown(root, uid, gid);
	yield* fs.chmod(
		root,
		stat.type === "Directory" ? (shared ? 0o750 : 0o700) : (shared ? 0o640 : 0o600) | (stat.mode & 0o111),
	);
	if (stat.type === "Directory")
		for (const child of yield* fs.readDirectory(root)) yield* ownTree(path.join(root, child), uid, gid, shared);
});

export const prepareWorkspace = Effect.fn("ownership.workspace")(function* (workspace: string, uid: number) {
	if (!/^\/data\/cache\/\.prepare-[^/]+\/workspace$/.test(workspace))
		return yield* Effect.die("Invalid preparation workspace");
	if ((yield* regular(workspace)).type !== "Directory") return yield* Effect.die("Invalid preparation workspace");
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	yield* regular(path.dirname(workspace));
	yield* fs.chmod(path.dirname(workspace), 0o711);
	yield* ownTree(workspace, uid, uid, false);
});

/** Only the fixed installer may enter the persistent download cache; never traverse cached links. */
export const prepareBunCache = Effect.fn("ownership.bunCache")(function* (uid: 1000 | 1002) {
	const fs = yield* FileSystem.FileSystem;
	if ((yield* regular("/data/cache/bun")).type !== "Directory") return yield* Effect.die("Invalid Bun cache");
	yield* fs.chown("/data/cache/bun", uid, uid);
	yield* fs.chmod("/data/cache/bun", 0o700);
});

const sharePages = Effect.fn("ownership.pages")(function* (
	directory: string,
): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem | Path.Path> {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const stat = yield* regular(directory);
	if (stat.type !== "Directory" && stat.type !== "File") return yield* Effect.die("Invalid page tree");
	yield* fs.chown(directory, 1000, 1003);
	if (stat.type === "Directory") {
		yield* fs.chmod(directory, 0o2770);
		for (const name of yield* fs.readDirectory(directory)) yield* sharePages(path.join(directory, name));
	}
});

export const prepareApp = Effect.fn("ownership.app")(function* (
	config: typeof ChildConfiguration.Type,
): Effect.fn.Return<typeof ChildConfiguration.Type, PlatformError, FileSystem.FileSystem | Path.Path> {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	if (!/^\/data\/gen\/\d+\/source$/.test(config.cwd) || !config.entry.startsWith(`${config.cwd}/`))
		return yield* Effect.die("Invalid app snapshot");
	if (!/^[a-f0-9]{64}$/.test(config.attempt) || config.receipt !== `/data/attempts/${config.attempt}.closed`)
		return yield* Effect.die("Invalid app receipt");
	const descriptor = config.env.APP_STORE;
	const parsed = yield* (
		descriptor === undefined
			? childStore(undefined, config.env.APP_DATABASE)
			: parseDescriptor(descriptor).pipe(
					Effect.mapError((error) => new StoreError({ code: error.code, variable: "APP_STORE" })),
				)
	).pipe(Effect.orDie);
	const store =
		parsed._tag === "file" ? yield* childStore(descriptor, config.env.APP_DATABASE).pipe(Effect.orDie) : parsed;
	if (
		store._tag !== "file" &&
		(!config.remote || config.remote.dataDirectory !== "/data" || config.env.APP_DATABASE !== undefined)
	)
		return yield* Effect.die("Invalid remote app configuration");
	if (store._tag === "file" && config.remote) return yield* Effect.die("Invalid remote app configuration");
	yield* regular(config.entry);
	// Saved pre-generation dependency stores remain referenced by legacy snapshots.
	if (yield* fs.exists("/data/prepared")) yield* ownTree("/data/prepared", 1000, 1003, true);
	yield* ownTree(config.cwd, 1000, 1003, true);
	for (const directory of ["/data/gen", path.dirname(config.cwd)]) {
		yield* regular(directory);
		yield* fs.chown(directory, 1000, 1003);
		yield* fs.chmod(directory, 0o750);
	}
	if (yield* fs.exists(`${config.cwd}.board`)) yield* ownTree(`${config.cwd}.board`, 1000, 1003, true);
	if (yield* fs.exists("/data/pages")) yield* sharePages("/data/pages");
	if (store._tag !== "file") {
		return { ...config, env: { ...config.env, TMPDIR: "/data/runtime", HOME: "/data/runtime" } };
	}
	const filename = store.filename;
	if (config.env.STATE !== "rehearsal") {
		if (filename !== "/data/store/comms.db") return yield* Effect.die("Invalid live database");
		// SQLite can create a main file with a stricter mode than the shared directory.
		// Never create an absent store here: initialized-store loss belongs to recovery.
		for (const file of [filename, `${filename}-wal`, `${filename}-shm`]) {
			if (yield* fs.exists(file)) {
				if ((yield* regular(file)).type !== "File") return yield* Effect.die("Invalid live database");
				yield* fs.chown(file, 1001, 1003);
				yield* fs.chmod(file, 0o660);
			}
		}
		return { ...config, env: { ...config.env, TMPDIR: "/data/runtime", HOME: "/data/runtime" } };
	}
	if (!filename.startsWith("/data/") || (yield* regular(filename)).type !== "File")
		return yield* Effect.die("Invalid rehearsal database");
	const directory = `/data/rehearsals/${config.attempt}`;
	yield* fs.makeDirectory(directory, { mode: 0o700 });
	yield* fs.copyFile(filename, `${directory}/comms.db`);
	yield* ownTree(directory, 1001, 1003, false);
	return {
		...config,
		env: {
			...config.env,
			APP_STORE: Redacted.value(yield* render({ _tag: "file", filename: `${directory}/comms.db` }).pipe(Effect.orDie)),
			APP_DATABASE: `${directory}/comms.db`,
		},
	};
});
