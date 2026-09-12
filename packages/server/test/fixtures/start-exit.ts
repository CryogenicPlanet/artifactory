// Process regression for the real startServer entry's handling of a guardian result.
import { mock } from "bun:test";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { ConfigProvider, Console, Effect, Layer } from "effect";
import { databaseConfiguration } from "@comms/boot";
const code = Number(process.argv[2]);
if (code !== 0 && code !== 17) throw new Error("Unsupported fixture exit");
mock.module("@comms/boot", () => ({
	databaseConfiguration,
	boot: () => Effect.die("Unexpected inner boot"),
	launchRemoteRoot: () =>
		Effect.gen(function* () {
			yield* Effect.addFinalizer(() => Console.error("Guardian closure completed"));
			return code;
		}),
}));
const { startServer } = await import("../../src/start.ts");
startServer().pipe(
	Effect.provide(
		Layer.mergeAll(
			BunServices.layer,
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					DATA_DIR: process.argv[3],
					DATABASE_URL: "postgres://app:fixture@localhost:5432/app",
					BOOT_DATABASE_URL: "postgres://boot:fixture@localhost:5432/boot",
					DATABASE_TLS: "false",
				}),
			),
		),
	),
	(effect) => BunRuntime.runMain(effect, { disableErrorReporting: true }),
);
