import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { dumpRemote, loadRemote } from "../../src/remote-copy.ts";
import type { RemoteStore } from "../../src/store.ts";
const Config = Schema.fromJsonString(
	Schema.Struct({
		engine: Schema.String,
		host: Schema.String,
		port: Schema.Number,
		database: Schema.String,
		username: Schema.String,
		password: Schema.String,
	}),
);
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const sourcePath = process.argv[2];
	const targetPath = process.argv[3];
	const artifactPath = process.argv[4];
	if (!sourcePath || !targetPath || !artifactPath) return yield* Effect.die("Missing fixture paths");
	const read = (path: string) =>
		fs.readFileString(path).pipe(
			Effect.flatMap(Schema.decodeEffect(Config)),
			Effect.map((config): RemoteStore => {
				const engine = config.engine === "pg" || config.engine === "postgres" ? "postgres" : "mysql";
				return {
					_tag: engine,
					database: config.database,
					url: Redacted.make(
						`${engine}://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${encodeURIComponent(config.database)}`,
					),
				};
			}),
		);
	const source = yield* read(sourcePath);
	const target = yield* read(targetPath);
	const artifact = yield* dumpRemote({ store: source, path: artifactPath, budget: "10 seconds" });
	yield* loadRemote({ store: target, artifact, budget: "10 seconds" });
	return { engine: artifact.engine, bytes: artifact.bytes };
});
main.pipe(
	Effect.result,
	Effect.flatMap((result) => Console.log(JSON.stringify(result))),
	Effect.provide(BunServices.layer),
	BunRuntime.runMain,
);
