import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Option, Path } from "effect";
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
	// Optional extra configured origin for multi-origin authentication tests.
	const primaryOrigin = Option.getOrElse(
		yield* Config.option(Config.String("PRIMARY_ORIGIN")),
		() => "https://comms.test",
	);
	const additional = yield* Config.option(Config.String("ADDITIONAL_ORIGIN"));
	return yield* boot({
		dataDirectory,
		seedDirectory: path.dirname(entry),
		entryFile: path.basename(entry),
		dependenciesDirectory,
		auth: {
			rpId: new URL(primaryOrigin).hostname,
			expectedOrigin: primaryOrigin,
			additionalOrigins: Option.toArray(additional)
				.flatMap((value) => value.split(","))
				.map((origin) => ({
					rpId: new URL(origin).hostname,
					expectedOrigin: origin,
				})),
		},
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, gracefulShutdownTimeout: "2 seconds" }),
				FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)(fetchOptions))),
			),
		),
	);
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
