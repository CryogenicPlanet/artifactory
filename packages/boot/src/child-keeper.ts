import { childIdentity, prepareApp } from "./linux-ownership.ts";
import { ChildConfiguration } from "./keeper-configuration.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, Exit, FileSystem, Path, Redacted, Schema, Scope, Stdio, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

// Immutable owner of one editable app process group, including ordinary descendants.
// Parent pipe EOF closes the group even if the child event loop hangs.
const keeper = Effect.gen(function* () {
	const encoded = yield* Config.Redacted("COMMS_CHILD_CONFIG");
	const supplied = yield* Schema.decodeEffect(Schema.fromJsonString(ChildConfiguration))(Redacted.value(encoded)).pipe(
		Effect.orDie,
	);
	const isolated = yield* Config.Boolean("COMMS_ISOLATED").pipe(Config.withDefault(false));
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const receipt = Effect.scoped(
		Effect.gen(function* () {
			const temporary = `${supplied.receipt}.tmp`;
			const handle = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
			yield* handle.writeAll(new TextEncoder().encode(supplied.attempt));
			if (isolated) yield* fs.chown(temporary, 1000, 1000);
			yield* handle.sync;
			yield* fs.rename(temporary, supplied.receipt);
			yield* (yield* fs.open(path.dirname(supplied.receipt))).sync;
		}),
	).pipe(Effect.orDie);
	let spawnAttempted = false;
	if (isolated) {
		if (!/^[a-f0-9]{64}$/.test(supplied.attempt) || supplied.receipt !== `/data/attempts/${supplied.attempt}.closed`)
			return yield* Effect.die("Invalid app receipt");
		// Preflight failure proves no editable subprocess was attempted. A spawn error does not.
		yield* Effect.addFinalizer(() =>
			spawnAttempted
				? Effect.void
				: Effect.gen(function* () {
						if (supplied.env.STATE === "rehearsal")
							yield* fs.remove(`/data/rehearsals/${supplied.attempt}`, { recursive: true, force: true });
						yield* receipt;
					}).pipe(Effect.orDie),
		);
	}
	const config = isolated ? yield* prepareApp(supplied) : supplied;
	const stdio = yield* Stdio.Stdio;
	const scope = yield* Scope.make();
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			spawnAttempted = true;
			const child = yield* spawner
				.spawn(
					ChildProcess.make(
						isolated ? "/usr/bin/setpriv" : process.execPath,
						isolated ? [...childIdentity, process.execPath, config.entry] : [config.entry],
						{
							cwd: config.cwd,
							env: config.env,
							stdin: "ignore",
							stdout: "pipe",
							stderr: "pipe",
							detached: true,
							forceKillAfter: "2 seconds",
						},
					),
				)
				.pipe(Effect.provideService(Scope.Scope, scope));
			// Effect exposes leader status, not positive group closure. Only ESRCH
			// proves absence; permission errors must never authorize a receipt.
			const groupRunning = Effect.try(() => {
				try {
					process.kill(-Number(child.pid), 0);
					return true;
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
					throw new Error("Child group closure could not be verified");
				}
			}).pipe(Effect.orDie);
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					// Scoped spawner release skips a successful exited leader even when
					// descendants still hold the app store. Kill before accepting proof.
					if (yield* groupRunning) yield* child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.exit);
					yield* Scope.close(scope, Exit.void);
					// Scope cleanup may swallow kill errors; observing exit is the actual closure proof.
					yield* child.exitCode.pipe(Effect.exit);
					if (yield* child.isRunning.pipe(Effect.orDie))
						return yield* Effect.die("Child closure could not be verified");
					let absent = false;
					for (let attempt = 0; attempt < 25; attempt++) {
						const probe = yield* groupRunning.pipe(Effect.exit);
						if (probe._tag === "Success" && !probe.value) {
							absent = true;
							break;
						}
						yield* Effect.sleep("20 millis");
					}
					if (!absent) return yield* Effect.die("Child group closure could not be verified");
					if (isolated && config.env.STATE === "rehearsal")
						yield* fs.remove(`/data/rehearsals/${config.attempt}`, { recursive: true }).pipe(Effect.orDie);
					yield* receipt;
				}).pipe(Effect.ensuring(Scope.close(scope, Exit.void))),
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
