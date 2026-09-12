import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, ConfigProvider, Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { databaseConfiguration } from "../../src/database-configuration.ts";
import { launchRemoteRoot } from "../../src/remote-root-launcher.ts";
import { remoteRuntime } from "../../src/remote-runtime.ts";

const Connection = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const descriptor = (filename: string) =>
		fs.readFileString(filename).pipe(
			Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Connection))),
			Effect.map(
				(value) =>
					`${value.engine === "pg" ? "postgres" : "mysql"}://${encodeURIComponent(value.username)}:${encodeURIComponent(value.password)}@${value.host}:${value.port}/${encodeURIComponent(value.database)}`,
			),
		);
	const app = yield* descriptor(yield* Config.String("COMMS_REMOTE_TEST_CONFIG"));
	const boot = yield* descriptor(yield* Config.String("COMMS_REMOTE_BOOT_TEST_CONFIG"));
	const directory = yield* fs.realPath(yield* Config.String("DATA_DIR"));
	const configured = Effect.gen(function* () {
		const selected = yield* databaseConfiguration("unused-boot", "unused-app");
		if (selected._tag !== "remote") return yield* Effect.die("Expected remote configuration");
		const parent = yield* Config.Redacted("COMMS_REMOTE_ROOT_CONFIG").pipe(Config.withDefault(undefined));
		if (parent === undefined) {
			yield* launchRemoteRoot(selected, {
				dataDirectory: directory,
				entry: yield* path.fromFileUrl(new URL(import.meta.url)),
				env: {},
			});
			return;
		}
		const runtime = yield* remoteRuntime(selected, directory);
		yield* runtime.bootSql.unsafe("SELECT 1");
		const mode = yield* Config.String("COMMS_ROOT_TEST_MODE");
		if (mode === "reserved") yield* runtime.reserveOwner(selected.app, "e5".repeat(32));
		yield* Console.log(`REMOTE_ROOT_WORKER=${process.pid}`);
		if (mode !== "clean") return yield* Effect.never;
	});
	return yield* configured.pipe(
		Effect.provide(
			ConfigProvider.layer(
				ConfigProvider.fromEnv({
					env: { ...process.env, DATABASE_URL: app, BOOT_DATABASE_URL: boot, DATABASE_TLS: "false" },
				}),
			),
		),
	);
});
program.pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
	BunRuntime.runMain,
);
