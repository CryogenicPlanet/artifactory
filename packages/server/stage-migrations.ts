import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const source = yield* path.fromFileUrl(new URL("./src/migrations", import.meta.url));
	const target = yield* path.fromFileUrl(new URL("./dist/migrations", import.meta.url));
	yield* fs.remove(target, { recursive: true, force: true });
	yield* fs.copy(source, target);
}).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
