import { Effect, Exit, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { databaseConfiguration } from "./database-configuration.ts";
import { remoteRootGuardian } from "./remote-root-guardian.ts";

type Configuration = Extract<Effect.Success<ReturnType<typeof databaseConfiguration>>, { readonly _tag: "remote" }>;

/** Invert launch only for remote stores: the inspector survives a boot worker SIGKILL. */
export const launchRemoteRoot = (
	configuration: Configuration,
	options: {
		readonly dataDirectory: string;
		readonly entry: string;
		readonly env: Readonly<Record<string, string>>;
	},
) =>
	Effect.gen(function* () {
		const guardian = yield* remoteRootGuardian(configuration, options.dataDirectory);
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const workerScope = yield* Scope.make();
		yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));
		return yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const worker = yield* spawner
					.spawn(
						ChildProcess.make(process.execPath, [options.entry], {
							env: { ...options.env, COMMS_REMOTE_ROOT_CONFIG: JSON.stringify(guardian.configuration) },
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
				yield* Effect.addFinalizer(() =>
					guardian.close(closure).pipe(Effect.ensuring(Scope.close(workerScope, Exit.void)), Effect.orDie),
				);
				return yield* restore(worker.exitCode);
			}),
		);
	});
