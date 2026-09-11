import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";

/** Root image entrypoint only: fixed directories, no recursive ownership repair. */
Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	for (const [directory, uid, gid, mode] of [
		["/data", 1000, 1000, 0o711],
		["/data/store", 1001, 1003, 0o2770],
		["/data/cache", 1000, 1000, 0o711],
		["/data/rehearsals", 1000, 1000, 0o711],
		["/data/runtime", 1001, 1003, 0o700],
	] as const) {
		yield* fs.makeDirectory(directory, { recursive: true, mode });
		if ((yield* fs.realPath(directory)) !== directory || (yield* fs.stat(directory)).type !== "Directory")
			return yield* Effect.die("Invalid deployment directory");
		yield* fs.chown(directory, uid, gid);
		yield* fs.chmod(directory, mode);
	}
	if (yield* fs.exists("/data/boot.db")) {
		if ((yield* fs.realPath("/data/boot.db")) !== "/data/boot.db") return yield* Effect.die("Invalid boot database");
		yield* fs.chmod("/data/boot.db", 0o600);
	}
}).pipe(Effect.scoped, Effect.provide(BunServices.layer), BunRuntime.runMain);
