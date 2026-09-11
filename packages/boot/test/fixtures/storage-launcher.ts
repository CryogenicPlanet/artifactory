import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { boot } from "../../src/index.ts";

const main = Effect.gen(function* () {
	const entry = yield* Config.String("ENTRY");
	const dataDirectory = yield* Config.String("DATA_DIR");
	const path = yield* Path.Path;
	const dependenciesDirectory = yield* path.fromFileUrl(new URL("../../../server/node_modules", import.meta.url));
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const available = process.argv[2] === "low" ? 1024 : 52428800;
	// Only the filesystem capacity sample is synthetic; keep actual keeper and app processes.
	const sampleSpawner = ChildProcessSpawner.make((command) => {
		if (command._tag !== "StandardCommand" || !["/bin/df", "/usr/bin/stat"].includes(command.command))
			return spawner.spawn(command);
		const output =
			command.command === "/bin/df"
				? `Filesystem 1024-blocks Used Available Capacity Mounted on\ntest 104857600 1 ${available} 1% /\n`
				: `1024 104857600 ${available}\n`;
		return spawner.spawn(ChildProcess.make("/usr/bin/printf", ["%s", output], { stdout: "pipe" }));
	});
	return yield* boot({
		dataDirectory,
		seedDirectory: path.dirname(entry),
		entryFile: path.basename(entry),
		dependenciesDirectory,
		auth: { rpId: "comms.test", expectedOrigin: "https://comms.test" },
	}).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, sampleSpawner));
}).pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(
			BunServices.layer,
			BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, gracefulShutdownTimeout: "2 seconds" }),
			FetchHttpClient.layer,
		),
	),
);
main.pipe(BunRuntime.runMain);
