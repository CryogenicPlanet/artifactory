import { Config, Effect, FileSystem, Path, Schema } from "effect";
import type { databaseConfiguration } from "./database-configuration.ts";
import { remoteRootGuardian } from "./remote-root-guardian.ts";
import { remoteOwnerInventory } from "./remote-owner-inventory.ts";
import { ownedSqlWorker } from "./owned-sql-worker.ts";
import { RemoteTransferConfiguration } from "./remote-transfer-configuration.ts";

type Configuration = Effect.Success<ReturnType<typeof databaseConfiguration>>;

/** Image-only outer transfer owner. Returning requires positive closure of both independent endpoints.
 * The caller publishes filesystem activation only after this scoped function succeeds and the worker exits zero. */
export const launchRemoteTransfer = (
	source: Configuration,
	target: Configuration,
	options: {
		readonly dataDirectory: string;
		readonly transferId: string;
		readonly entry: string;
		readonly env: Readonly<Record<string, string>>;
	},
) =>
	Effect.scoped(
		Effect.gen(function* () {
			if (
				process.platform !== "linux" ||
				(yield* Config.String("COMMS_LOCKED_COMMAND").pipe(Config.withDefault(""))) !== "store-transfer"
			)
				return yield* Effect.die("Offline transfer requires the locked image entrypoint");
			if (
				source._tag === "remote" &&
				target._tag === "remote" &&
				source.bootConnection.engine === target.bootConnection.engine &&
				source.bootConnection.host === target.bootConnection.host &&
				source.bootConnection.port === target.bootConnection.port &&
				source.bootConnection.username === target.bootConnection.username
			)
				return yield* Effect.die("Transfer endpoint guardians require distinct boot principals");
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const transfer = path.join(options.dataDirectory, "transfers", options.transferId);
			yield* Schema.decodeUnknownEffect(RemoteTransferConfiguration)({
				transferId: options.transferId,
				source: null,
				target: null,
			});
			if (
				(yield* fs.realPath(options.dataDirectory)) !== options.dataDirectory ||
				(yield* fs.realPath(transfer)) !== transfer ||
				(yield* fs.stat(transfer)).type !== "Directory"
			)
				return yield* Effect.die("Transfer ownership directory must be canonical");
			let spawnAttempted = false;
			let worker: Effect.Success<ReturnType<typeof ownedSqlWorker>> | undefined;
			const closeWorker = Effect.suspend(() =>
				!spawnAttempted ? Effect.void : worker ? worker.close : Effect.die("Transfer worker closure unproven"),
			);
			const own = (configuration: Extract<Configuration, { readonly _tag: "remote" }>, directory: string) =>
				Effect.gen(function* () {
					const guardian = yield* remoteRootGuardian(configuration, directory);
					yield* Effect.addFinalizer(() => guardian.close(closeWorker).pipe(Effect.orDie));
					return { directory, guardian: guardian.configuration };
				}).pipe(Effect.uninterruptible);
			// Acquire endpoint ownership in source/target order. Historical source receipts are checked even
			// when SQLite is selected after a prior remote deployment; absence never substitutes for evidence.
			const sourceOwner = source._tag === "remote" ? yield* own(source, options.dataDirectory) : null;
			if (source._tag === "file") yield* remoteOwnerInventory(options.dataDirectory);
			let targetOwner: typeof sourceOwner = null;
			if (target._tag === "remote") {
				const directory = path.join(transfer, "target-owners");
				if (!(yield* fs.exists(directory))) {
					yield* fs.makeDirectory(directory, { mode: 0o700 });
					yield* Effect.scoped(fs.open(transfer).pipe(Effect.flatMap((file) => file.sync)));
				}
				targetOwner = yield* own(target, directory);
			}
			const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RemoteTransferConfiguration))({
				transferId: options.transferId,
				source: sourceOwner,
				target: targetOwner,
			});
			return yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					spawnAttempted = true;
					worker = yield* ownedSqlWorker({
						entry: options.entry,
						env: { ...options.env, COMMS_REMOTE_TRANSFER_CONFIG: encoded },
					});
					// SQLite-only transfers still close the worker group, including ordinary descendants.
					yield* Effect.addFinalizer(() => closeWorker.pipe(Effect.orDie));
					return yield* restore(worker.exitCode);
				}),
			);
		}),
	);
