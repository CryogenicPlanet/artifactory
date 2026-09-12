import { boot, launchRemoteRoot, databaseConfiguration } from "@comms/boot";
import { BunHttpServer } from "@effect/platform-bun";
import { Config, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

/** Launches the editable app through boot.
 * The child uses a separate entry to avoid recursively launching boot. */
export const startServer = (browserOrigin?: string) =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const seedDirectory = yield* path.fromFileUrl(
			new URL(import.meta.url.endsWith(".ts") ? "../dist/runtime-seed" : "./runtime-seed", import.meta.url),
		);
		const dataDirectory = yield* Config.String("DATA_DIR").pipe(Config.withDefault("./data"));
		const absoluteData = path.resolve(dataDirectory);
		const selected = yield* databaseConfiguration(
			path.join(absoluteData, "boot.db"),
			path.join(absoluteData, "comms.db"),
		);
		const parent = yield* Config.Redacted("COMMS_REMOTE_ROOT_CONFIG").pipe(Config.withDefault(undefined));
		if (selected._tag === "remote" && parent === undefined) {
			yield* (yield* FileSystem.FileSystem).makeDirectory(absoluteData, { recursive: true, mode: 0o700 });
			return yield* launchRemoteRoot(selected, {
				dataDirectory: absoluteData,
				entry: yield* path.fromFileUrl(
					new URL(import.meta.url.endsWith(".ts") ? "./main.ts" : "./main.js", import.meta.url),
				),
				env: browserOrigin
					? { PUBLIC_ORIGIN: yield* Config.String("PUBLIC_ORIGIN").pipe(Config.withDefault(browserOrigin)) }
					: {},
			});
		}
		const fetchOptions: RequestInit & { decompress: boolean } = { redirect: "manual", decompress: false };
		const port = yield* Config.Port("PORT").pipe(Config.withDefault(8080));
		const hostname = yield* Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
		const rpId = yield* Config.String("RP_ID").pipe(Config.withDefault("localhost"));
		const expectedOrigin = yield* Config.String("PUBLIC_ORIGIN").pipe(
			Config.withDefault(browserOrigin ?? (rpId === "localhost" ? `http://localhost:${port}` : `https://${rpId}`)),
		);
		return yield* boot({
			dataDirectory: path.resolve(dataDirectory),
			seedDirectory,
			seedPagesDirectory: yield* path.fromFileUrl(new URL("../pages", import.meta.url)),
			entryFile: "server.ts",
			auth: { rpId, expectedOrigin },
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					BunHttpServer.layer({ hostname, port, idleTimeout: 0, gracefulShutdownTimeout: "2 seconds" }),
					FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)(fetchOptions))),
				),
			),
		);
	}).pipe(Effect.scoped);
