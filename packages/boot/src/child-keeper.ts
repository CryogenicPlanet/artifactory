import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, Exit, FileSystem, Path, Redacted, Schema, Scope, Stdio, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const Configuration = Schema.Struct({
	entry: Schema.String,
	cwd: Schema.String,
	env: Schema.Record(Schema.String, Schema.String),
	receipt: Schema.String,
	attempt: Schema.String,
});

// Immutable owner of one editable app process. Parent pipe EOF closes the child even if its event loop hangs.
const keeper = Effect.gen(function* () {
	const encoded = yield* Config.Redacted("COMMS_CHILD_CONFIG");
	const config = yield* Schema.decodeEffect(Schema.fromJsonString(Configuration))(Redacted.value(encoded)).pipe(
		Effect.orDie,
	);
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const stdio = yield* Stdio.Stdio;
	const scope = yield* Scope.make();
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const child = yield* spawner
				.spawn(
					ChildProcess.make(process.execPath, [config.entry], {
						cwd: config.cwd,
						env: config.env,
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
						forceKillAfter: "2 seconds",
					}),
				)
				.pipe(Effect.provideService(Scope.Scope, scope));
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					yield* Scope.close(scope, Exit.void);
					// Scope cleanup may swallow kill errors; observing exit is the actual closure proof.
					yield* child.exitCode.pipe(Effect.exit);
					if (yield* child.isRunning.pipe(Effect.orDie))
						return yield* Effect.die("Child closure could not be verified");
					const temporary = `${config.receipt}.tmp`;
					yield* Effect.scoped(
						Effect.gen(function* () {
							const handle = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
							yield* handle.writeAll(new TextEncoder().encode(config.attempt));
							yield* handle.sync;
							yield* fs.rename(temporary, config.receipt);
							yield* (yield* fs.open(path.dirname(config.receipt))).sync;
						}),
					).pipe(Effect.orDie);
				}),
			);
			yield* Console.log(`COMMS_CHILD_PID=${child.pid}`);
			yield* child.stdout.pipe(Stream.run(stdio.stdout()), Effect.forkScoped);
			yield* child.stderr.pipe(Stream.run(stdio.stderr()), Effect.forkScoped);
			yield* restore(Effect.raceFirst(child.exitCode.pipe(Effect.exit), stdio.stdin.pipe(Stream.runDrain)));
		}),
	);
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
// Effect Stdio intentionally leaves inherited stdin open. This entry owns that pipe and closes it after all receipts/finalizers.
keeper.pipe(Effect.ensuring(Effect.sync(() => process.stdin.destroy())), BunRuntime.runMain);
