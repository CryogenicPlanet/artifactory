import { startServer } from "@comms/server";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Path } from "effect";
import { createServer } from "vite";

const dev = Effect.gen(function* () {
	const path = yield* Path.Path;
	const root = yield* path.fromFileUrl(new URL(".", import.meta.url));
	const vite = yield* Effect.acquireRelease(
		Effect.tryPromise(() => createServer({ root, configFile: path.join(root, "vite.config.ts") })),
		(vite) => Effect.promise(() => vite.close()),
	);
	yield* Effect.tryPromise(() => vite.listen());
	yield* Effect.sync(() => vite.printUrls());
	const uiPort = yield* Config.Port("UI_PORT").pipe(Config.withDefault(5173));
	return yield* startServer(`http://localhost:${uiPort}`);
});

dev.pipe(Effect.scoped, Effect.provide(BunServices.layer), BunRuntime.runMain);
