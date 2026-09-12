import { fileURLToPath } from "node:url";
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { boot, databaseConfiguration, launchRemoteRoot } from "../../../boot/src/index.ts";

// Copied beside a disposable boot source tree by the acceptance test. Only that
// private copy receives fault barriers; the real guardian and HTTP graph run intact.
const program = Effect.gen(function* () {
	const root = yield* Config.String("DATA_DIR");
	const entry = yield* Config.String("ENTRY");
	const path = yield* Path.Path;
	const config = yield* databaseConfiguration(`${root}/boot.db`, `${root}/comms.db`);
	if (config._tag !== "remote") return yield* Effect.die("Expected disposable remote pair");
	const parent = yield* Config.Redacted("COMMS_REMOTE_ROOT_CONFIG").pipe(Config.withDefault(undefined));
	if (parent === undefined)
		return yield* launchRemoteRoot(config, { dataDirectory: root, entry: fileURLToPath(import.meta.url), env: {} });
	yield* (yield* FileSystem.FileSystem).writeFileString(`${root}/worker.pid`, String(process.pid), { mode: 0o600 });
	const fetchOptions: RequestInit & { decompress: boolean } = { redirect: "manual", decompress: false };
	return yield* boot({
		dataDirectory: root,
		seedDirectory: path.dirname(entry),
		entryFile: path.basename(entry),
		dependenciesDirectory: yield* Config.String("DEPENDENCIES_DIRECTORY"),
		auth: { rpId: "comms.test", expectedOrigin: "https://comms.test" },
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, gracefulShutdownTimeout: "2 seconds" }),
				FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, fetchOptions))),
			),
		),
	);
});
program.pipe(Effect.scoped, Effect.provide(BunServices.layer), BunRuntime.runMain);
