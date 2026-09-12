import { BunRuntime } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { bootstrapConfiguration, bootstrapServices } from "./transfer-bootstrap-config.ts";

// This wrapper supplies private descriptors. The historical main and guardian are unmodified.
Effect.gen(function* () {
	const config = yield* bootstrapConfiguration;
	const historical = process.argv[5];
	const port = process.argv[6];
	if (!historical || !port || !/^[0-9]+$/.test(port)) return yield* Effect.die("Missing historical root");
	const fs = yield* FileSystem.FileSystem;
	const environment = { ...process.env };
	delete environment.COMMS_REMOTE_ROOT_CONFIG;
	const child = Bun.spawn(["bun", `${historical}/packages/server/src/main.ts`], {
		cwd: historical,
		detached: true,
		env: {
			...environment,
			DATABASE_URL: config.appUrl,
			BOOT_DATABASE_URL: config.bootUrl,
			DATABASE_TLS: "false",
			COMMS_ISOLATED: "false",
			DATA_DIR: config.dataDirectory,
			PORT: port,
			HOST: "127.0.0.1",
			RP_ID: "localhost",
			PUBLIC_ORIGIN: "http://localhost:8080",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	yield* fs.writeFileString(`${config.dataDirectory}/historical.pid`, String(child.pid));
	const copy = async (stream: ReadableStream<Uint8Array>, output: typeof process.stdout | typeof process.stderr) => {
		for await (const chunk of stream) output.write(chunk);
	};
	const exited = yield* Effect.promise(() =>
		Promise.all([child.exited, copy(child.stdout, process.stdout), copy(child.stderr, process.stderr)]),
	);
	if (exited[0] !== 0) process.exitCode = 1;
}).pipe(Effect.scoped, Effect.provide(bootstrapServices), BunRuntime.runMain);
