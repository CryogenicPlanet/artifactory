import { Cause, Effect, Exit } from "effect";
import type { databaseConfiguration } from "./database-configuration.ts";
import { remoteRootGuardian } from "./remote-root-guardian.ts";
import { ownedSqlWorker } from "./owned-sql-worker.ts";

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
		// This invocation owns its signal observation; arbitrary fiber interruption remains force-first.
		let operatorSignal = false;
		const observeStop = () => {
			operatorSignal = true;
		};
		yield* Effect.acquireRelease(
			Effect.sync(() => {
				// Run before BunRuntime's listener interrupts the main fiber.
				process.prependListener("SIGINT", observeStop);
				process.prependListener("SIGTERM", observeStop);
			}),
			() =>
				Effect.sync(() => {
					process.removeListener("SIGINT", observeStop);
					process.removeListener("SIGTERM", observeStop);
				}),
		);
		const guardian = yield* remoteRootGuardian(configuration, options.dataDirectory);
		return yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const worker = yield* ownedSqlWorker({
					entry: options.entry,
					env: { ...options.env, COMMS_REMOTE_ROOT_CONFIG: JSON.stringify(guardian.configuration) },
				});
				yield* Effect.addFinalizer((exit) => {
					// Capture the cause before waiting: a later signal cannot soften an abnormal exit.
					const graceful = operatorSignal && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
					return Effect.gen(function* () {
						// Admission must stay live while the worker drains publication.
						if (graceful) yield* worker.shutdown;
						yield* guardian.close(worker.close);
					}).pipe(Effect.orDie);
				});
				return yield* restore(worker.exitCode);
			}),
		);
	});
