import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { boot } from "../../src/index.ts";

const fetchOptions: Readonly<BunFetchRequestInit> = Object.freeze({ redirect: "manual", decompress: false });
const main = Effect.gen(function* () {
	const entry = yield* Config.String("ENTRY");
	const dataDirectory = yield* Config.String("DATA_DIR");
	const path = yield* Path.Path;
	const installedDependencies = yield* path.fromFileUrl(new URL("../../../server/node_modules", import.meta.url));
	const dependenciesDirectory = yield* Config.String("DEPENDENCIES_DIRECTORY").pipe(
		Config.withDefault(installedDependencies),
	);
	return yield* boot({
		dataDirectory,
		seedDirectory: path.dirname(entry),
		entryFile: path.basename(entry),
		dependenciesDirectory,
		auth: { rpId: "comms.test", expectedOrigin: "https://comms.test" },
	});
}).pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(
			BunServices.layer,
			BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, gracefulShutdownTimeout: "2 seconds" }),
			FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)(fetchOptions))),
		),
	),
);
main.pipe(BunRuntime.runMain);
