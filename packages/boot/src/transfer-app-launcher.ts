import { type Store, render } from "@comms/storage/store";
import { Cause, Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { startChildKeeper } from "./child-keeper-process.ts";
import type { RemoteChildConfiguration } from "./keeper-configuration.ts";

export class TransferAppTaskError extends Schema.TaggedError<TransferAppTaskError>()("TransferAppTaskError", {
	code: Schema.Literals(["transfer_source_incompatible", "transfer_app_task_failed"]),
}) {}

/** Read-only capability check. Installed source is never imported by the immutable parent. */
export const preflightTransferAppSource = (sourceDirectory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		for (const filename of [
			sourceDirectory,
			path.join(sourceDirectory, "transfer-app-worker.ts"),
			path.join(sourceDirectory, "kernel/transfer-app-initialize.ts"),
		]) {
			if (
				(yield* fs.realPath(filename)) !== filename ||
				(yield* fs.stat(filename)).type !== (filename === sourceDirectory ? "Directory" : "File")
			)
				return yield* new TransferAppTaskError({ code: "transfer_source_incompatible" });
		}
	}).pipe(Effect.mapError(() => new TransferAppTaskError({ code: "transfer_source_incompatible" })));

/** Runs only the selected frozen app entry. The caller reserves a guarded target app owner first.
 * Raw result remains app-owned data; success requires both process and keeper closure. */
export const runTransferApp = (options: {
	readonly sourceDirectory: string;
	readonly transferDirectory: string;
	readonly dataDirectory: string;
	readonly targetStore: Store;
	readonly epoch: string;
	readonly sourceEngine: "sqlite" | "pg" | "mysql";
	readonly attempt: string;
	readonly remote?: typeof RemoteChildConfiguration.Type;
	readonly isolated: boolean;
}) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			yield* preflightTransferAppSource(options.sourceDirectory);
			if (!/^[0-9a-f]{64}(?![\s\S])/.test(options.attempt) || !/^[0-9a-f]{64}(?![\s\S])/.test(options.epoch))
				return yield* new TransferAppTaskError({ code: "transfer_app_task_failed" });
			for (const directory of [options.dataDirectory, options.transferDirectory])
				if ((yield* fs.realPath(directory)) !== directory || (yield* fs.stat(directory)).type !== "Directory")
					return yield* new TransferAppTaskError({ code: "transfer_app_task_failed" });
			if (
				path.dirname(path.dirname(options.transferDirectory)) !== options.dataDirectory ||
				path.basename(path.dirname(options.transferDirectory)) !== "transfers"
			)
				return yield* new TransferAppTaskError({ code: "transfer_app_task_failed" });
			const parent = path.join(options.dataDirectory, "rehearsals");
			if (!(yield* fs.exists(parent))) yield* fs.makeDirectory(parent, { mode: 0o700 });
			if ((yield* fs.realPath(parent)) !== parent || (yield* fs.stat(parent)).type !== "Directory")
				return yield* new TransferAppTaskError({ code: "transfer_app_task_failed" });
			const directory = path.join(parent, `transfer-${options.attempt}`);
			// A new attempt never consumes a stale success file from a previous worker.
			yield* fs.makeDirectory(directory, { mode: 0o700 });
			const result = path.join(directory, "result.json");
			const attempts = path.join(options.dataDirectory, "attempts");
			if (!(yield* fs.exists(attempts))) yield* fs.makeDirectory(attempts, { mode: 0o700 });
			if ((yield* fs.realPath(attempts)) !== attempts)
				return yield* new TransferAppTaskError({ code: "transfer_app_task_failed" });
			const keeper = yield* startChildKeeper(
				{
					entry: path.join(options.sourceDirectory, "transfer-app-worker.ts"),
					cwd: options.sourceDirectory,
					attempt: options.attempt,
					receipt: path.join(attempts, `${options.attempt}.closed`),
					...(options.remote ? { remote: options.remote } : {}),
					env: {
						STATE: "transfer",
						TRANSFER_ID: path.basename(options.transferDirectory),
						APP_STORE: Redacted.value(yield* render(options.targetStore)),
						WRITER_EPOCH: options.epoch,
						TRANSFER_SOURCE_ENGINE: options.sourceEngine,
						TRANSFER_APP_RESULT: result,
					},
				},
				options.isolated,
			);
			const exit = yield* keeper.handle.exitCode.pipe(Effect.ensuring(keeper.stop.pipe(Effect.orDie)));
			if (Number(exit) !== 0) return yield* new TransferAppTaskError({ code: "transfer_app_task_failed" });
			const stat = yield* fs.stat(result);
			// Proof metadata is a bounded control response, never transferred business rows.
			if ((yield* fs.realPath(result)) !== result || stat.type !== "File" || stat.size > 1048576)
				return yield* new TransferAppTaskError({ code: "transfer_app_task_failed" });
			const encoded = yield* fs.readFileString(result);
			return encoded;
		}),
	).pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.fail(new TransferAppTaskError({ code: "transfer_app_task_failed" })),
		),
	);
