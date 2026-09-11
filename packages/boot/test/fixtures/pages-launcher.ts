import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { boot } from "../../src/index.ts";

Effect.gen(function* () {
	const root = yield* Config.String("TEST_ROOT");
	const path = yield* Path.Path;
	const fs = yield* FileSystem.FileSystem;
	const instrumented = FileSystem.make({
		...fs,
		readFile: (name) =>
			Effect.gen(function* () {
				const bytes = yield* fs.readFile(name);
				if (name === path.join(root, "data/pages/held.md") && (yield* fs.exists(path.join(root, "pause-page")))) {
					yield* fs.writeFileString(path.join(root, "page-captured"), "ready");
					while (yield* fs.exists(path.join(root, "pause-page"))) yield* Effect.sleep("10 millis");
				}
				return bytes;
			}),
	});
	return yield* boot({
		dataDirectory: path.join(root, "data"),
		seedDirectory: path.join(root, "seed"),
		seedPagesDirectory: path.join(root, "seed-pages"),
		entryFile: "child.ts",
		dependenciesDirectory: yield* path.fromFileUrl(new URL("../../node_modules", import.meta.url)),
		auth: { rpId: "comms.test", expectedOrigin: "https://comms.test" },
	}).pipe(Effect.provideService(FileSystem.FileSystem, instrumented));
}).pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(
			BunServices.layer,
			FetchHttpClient.layer,
			BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, gracefulShutdownTimeout: "2 seconds" }),
		),
	),
	BunRuntime.runMain,
);
