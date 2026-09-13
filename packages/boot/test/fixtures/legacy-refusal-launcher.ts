import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { boot } from "../../src/index.ts";

const fetchOptions: Readonly<BunFetchRequestInit> = Object.freeze({ redirect: "manual", decompress: false });
const main = Effect.gen(function* () {
	const entry = yield* Config.String("ENTRY");
	const dataDirectory = yield* Config.String("DATA_DIR");
	const path = yield* Path.Path;
	const fs = yield* FileSystem.FileSystem;
	const observed = FileSystem.make({
		...fs,
		stat: (name) =>
			fs
				.stat(name)
				.pipe(
					Effect.tap(() =>
						name === path.join(dataDirectory, "boot.db")
							? fs.writeFileString(path.join(dataDirectory, "maintenance-observed"), "measured")
							: Effect.void,
					),
				),
	});
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
	}).pipe(
		Effect.provideService(FileSystem.FileSystem, observed),
		Effect.provide(
			Layer.mergeAll(
				BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, gracefulShutdownTimeout: "2 seconds" }),
				FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)(fetchOptions))),
			),
		),
	);
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
