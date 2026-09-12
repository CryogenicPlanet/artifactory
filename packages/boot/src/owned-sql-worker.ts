import { Effect, Exit, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** One immutable SQL worker group. Cached positive closure can be supplied to each endpoint guardian. */
export const ownedSqlWorker = (options: { readonly entry: string; readonly env: Readonly<Record<string, string>> }) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const workerScope = yield* Scope.make();
		yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));
		return yield* Effect.uninterruptibleMask(() =>
			Effect.gen(function* () {
				const worker = yield* spawner
					.spawn(
						ChildProcess.make(process.execPath, [options.entry], {
							env: options.env,
							extendEnv: true,
							stdin: "ignore",
							stdout: "inherit",
							stderr: "inherit",
							detached: true,
							forceKillAfter: "5 seconds",
						}),
					)
					.pipe(Effect.provideService(Scope.Scope, workerScope));
				const groupPresent = Effect.try(() => {
					try {
						process.kill(-Number(worker.pid), 0);
						return true;
					} catch (error) {
						if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
						throw new Error("Remote boot group observation failed");
					}
				});
				const closure = Effect.gen(function* () {
					// The leader may already have exited while ordinary descendants remain.
					if (yield* groupPresent)
						yield* Effect.try(() => {
							try {
								process.kill(-Number(worker.pid), "SIGKILL");
							} catch (error) {
								if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
									throw new Error("Remote boot group termination failed");
							}
						});
					yield* Scope.close(workerScope, Exit.void);
					yield* worker.exitCode.pipe(Effect.exit);
					if (yield* worker.isRunning) return yield* Effect.die("Remote boot worker closure unproven");
					for (let n = 0; n < 50; n++) {
						if (!(yield* groupPresent)) return;
						yield* Effect.sleep("20 millis");
					}
					return yield* Effect.die("Remote boot group closure unproven");
				});
				return { exitCode: worker.exitCode, close: yield* Effect.cached(closure) };
			}),
		);
	});
