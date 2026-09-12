import { Effect } from "effect";
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
		const guardian = yield* remoteRootGuardian(configuration, options.dataDirectory);
		return yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const worker = yield* ownedSqlWorker({
					entry: options.entry,
					env: { ...options.env, COMMS_REMOTE_ROOT_CONFIG: JSON.stringify(guardian.configuration) },
				});
				yield* Effect.addFinalizer(() => guardian.close(worker.close).pipe(Effect.orDie));
				return yield* restore(worker.exitCode);
			}),
		);
	});
