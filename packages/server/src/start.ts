import { boot } from "@comms/boot";
import { BunHttpServer } from "@effect/platform-bun";
import { Config, Effect, Layer, Option, Path } from "effect";
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
		const fetchOptions: RequestInit & { decompress: boolean } = { redirect: "manual", decompress: false };
		const port = yield* Config.Port("PORT").pipe(Config.withDefault(8080));
		const hostname = yield* Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
		const configuredRpId = yield* Config.option(Config.String("RP_ID"));
		const configuredOrigin = yield* Config.option(Config.String("PUBLIC_ORIGIN"));
		// PUBLIC_ORIGINS lists exact origins, primary first; each binds passkeys to its own hostname.
		const origins = yield* Config.option(Config.String("PUBLIC_ORIGINS"));
		const listed = Option.map(origins, (value) =>
			value
				.split(",")
				.map((origin) => origin.trim())
				.map((origin) => ({ rpId: URL.canParse(origin) ? new URL(origin).hostname : "", expectedOrigin: origin })),
		);
		const rpId = Option.getOrElse(configuredRpId, () => "localhost");
		const [primary, ...additionalOrigins] = Option.getOrElse(listed, () => [
			{
				rpId,
				expectedOrigin: Option.getOrElse(
					configuredOrigin,
					() => browserOrigin ?? (rpId === "localhost" ? `http://localhost:${port}` : `https://${rpId}`),
				),
			},
		]);
		// Two spellings of the same setting are ambiguous; an invalid RP ID makes boot refuse the configuration.
		const ambiguous = Option.isSome(origins) && (Option.isSome(configuredRpId) || Option.isSome(configuredOrigin));
		return yield* boot({
			dataDirectory: path.resolve(dataDirectory),
			seedDirectory,
			seedPagesDirectory: yield* path.fromFileUrl(new URL("../pages", import.meta.url)),
			entryFile: "server.ts",
			auth: {
				rpId: ambiguous || !primary ? "" : primary.rpId,
				expectedOrigin: primary?.expectedOrigin ?? "",
				additionalOrigins,
			},
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					BunHttpServer.layer({ hostname, port, idleTimeout: 0, gracefulShutdownTimeout: "2 seconds" }),
					FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)(fetchOptions))),
				),
			),
		);
	}).pipe(Effect.scoped);
