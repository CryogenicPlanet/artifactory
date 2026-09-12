import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, FileSystem, Path, Redacted, Schema, Stdio, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { SqliteCopyConfiguration, SqliteCopyReceipt } from "./sqlite-copy-configuration.ts";

// Remains responsive while the worker blocks in SQLite. Parent EOF closes the worker.
const keeper = Effect.gen(function* () {
	const encoded = yield* Config.Redacted("COMMS_SQLITE_COPY");
	const config = yield* Schema.decodeEffect(Schema.fromJsonString(SqliteCopyConfiguration))(Redacted.value(encoded));
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	if (
		!/^[a-f0-9]{64}$/.test(config.attempt) ||
		!Number.isFinite(config.budgetMs) ||
		config.budgetMs <= 0 ||
		!path.isAbsolute(config.source) ||
		!path.isAbsolute(config.destination) ||
		path.basename(config.receipt) !== `${config.attempt}.closed`
	)
		return yield* Effect.die("Invalid SQLite copy configuration");
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const stdio = yield* Stdio.Stdio;
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	const entry = yield* path.fromFileUrl(new URL(`./sqlite-copy-worker.${extension}`, import.meta.url));
	const child = yield* spawner.spawn(
		ChildProcess.make(process.execPath, [entry], {
			env: { COMMS_SQLITE_COPY: Redacted.value(encoded) },
			extendEnv: false,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			forceKillAfter: "2 seconds",
			detached: true,
		}),
	);
	const groupRunning = Effect.try(() => {
		try {
			process.kill(-Number(child.pid), 0);
			return true;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
			throw error;
		}
	}).pipe(Effect.orDie);
	const result = yield* Effect.raceFirst(
		child.exitCode.pipe(Effect.orElseSucceed(() => -1)),
		Effect.raceFirst(
			stdio.stdin.pipe(Stream.runDrain, Effect.as(-1)),
			Effect.sleep(config.budgetMs).pipe(Effect.as(-2)),
		),
	);
	if (yield* child.isRunning) yield* child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.exit);
	// A signal or a timeout is not evidence: await the only possible handle owner's exit.
	yield* child.exitCode.pipe(Effect.exit);
	if (yield* child.isRunning) return yield* Effect.die("SQLite copy closure unproven");
	if (yield* groupRunning)
		yield* Effect.try(() => {
			try {
				process.kill(-Number(child.pid), "SIGKILL");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
			}
		}).pipe(Effect.orDie);
	for (let attempt = 0; attempt < 50 && (yield* groupRunning); attempt++) yield* Effect.sleep("20 millis");
	if (yield* groupRunning) return yield* Effect.die("SQLite copy group closure unproven");
	const outcome = result === 0 ? "completed" : result === -2 ? "timeout" : "failed";
	const receipt = yield* Schema.encodeEffect(Schema.fromJsonString(SqliteCopyReceipt))({
		attempt: config.attempt,
		source: config.source,
		destination: config.destination,
		outcome,
	});
	yield* Effect.scoped(
		Effect.gen(function* () {
			const temporary = `${config.receipt}.tmp`;
			const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
			yield* file.writeAll(new TextEncoder().encode(receipt));
			yield* file.sync;
			yield* fs.rename(temporary, config.receipt);
			yield* (yield* fs.open(path.dirname(config.receipt))).sync;
		}),
	);
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
keeper.pipe(Effect.ensuring(Effect.sync(() => process.stdin.destroy())), BunRuntime.runMain);
