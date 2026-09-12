import { launchRemoteTransfer } from "@comms/boot";
import {
	TransferFileJournal,
	TransferRejected,
	validateTransferBinding,
	validateTransferPreparation,
	type TransferSelection,
} from "@comms/storage/store-transfer-schema";
import { writeTransferReceipt } from "@comms/storage/store-transfer-receipt";
import { Config, Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { encodeTransferConfiguration, type TransferConfiguration } from "./configuration.ts";

const invalid = () => new TransferRejected({ code: "transfer_journal_conflict" });

/** Root's image wrapper holds the volume lock; only the immutable worker opens app data clients. */
export const runTransfer = (configuration: TransferConfiguration) =>
	Effect.gen(function* () {
		if (
			process.platform !== "linux" ||
			(yield* Config.String("COMMS_LOCKED_COMMAND").pipe(Config.withDefault(""))) !== "store-transfer"
		)
			return yield* invalid();
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const dataDirectory = yield* Config.String("DATA_DIR").pipe(Config.withDefault("/data"));
		if (dataDirectory !== "/data" || (yield* fs.realPath(dataDirectory)) !== dataDirectory) return yield* invalid();
		const sync = (name: string) => Effect.scoped(fs.open(name).pipe(Effect.flatMap((file) => file.sync)));
		const ensureDirectory = (directory: string) =>
			Effect.gen(function* () {
				const parent = path.dirname(directory);
				if (!(yield* fs.readDirectory(parent)).includes(path.basename(directory))) {
					yield* fs.makeDirectory(directory, { mode: 0o700 });
					yield* sync(parent);
				}
				if ((yield* fs.realPath(directory)) !== directory || (yield* fs.stat(directory)).type !== "Directory")
					return yield* invalid();
			});
		const transfers = path.join(dataDirectory, "transfers");
		yield* ensureDirectory(transfers);
		const directory = path.join(transfers, configuration.transferId);
		yield* ensureDirectory(directory);
		const filename = path.join(directory, "journal.json");
		const matches = (
			pair: TransferSelection["source"],
			configured: TransferConfiguration["source"],
			target: boolean,
		) => {
			if (configured._tag === "file")
				return (
					pair.engine === "sqlite" &&
					pair.endpoint === null &&
					pair.boot === configured.boot.filename &&
					(!target || pair.app === configured.app.filename)
				);
			const connection = configured.bootConnection;
			const host = connection.host.includes(":") ? `[${connection.host}]` : connection.host;
			return (
				pair.engine === connection.engine &&
				pair.endpoint === `${host.toLowerCase()}:${connection.port}` &&
				pair.boot === configured.boot.database &&
				(!target || pair.app === configured.app.database)
			);
		};
		const read = Effect.gen(function* () {
			if (!(yield* fs.readDirectory(directory)).includes("journal.json")) return undefined;
			if ((yield* fs.realPath(filename)) !== filename || (yield* fs.stat(filename)).type !== "File")
				return yield* invalid();
			const journal = yield* fs
				.readFileString(filename)
				.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TransferFileJournal))),
					Effect.mapError(invalid),
				);
			const selection =
				journal.phase === "preparing"
					? (yield* validateTransferPreparation(journal)).selection
					: yield* validateTransferBinding(journal.binding);
			if (
				selection.transfer_id !== configuration.transferId ||
				selection.data_directory !== dataDirectory ||
				!matches(selection.source, configuration.source, false) ||
				!matches(selection.target, configuration.target, true)
			)
				return yield* invalid();
			return journal;
		});
		const report = (
			binding: Effect.Success<ReturnType<typeof validateTransferBinding>>,
			status: "checked" | "complete",
		) => ({
			transfer_id: binding.transfer_id,
			status,
			source: binding.source,
			target: binding.target,
			manifest: binding.manifest,
		});
		const prior = yield* read;
		if (prior?.phase === "complete") {
			yield* writeTransferReceipt(prior);
			return report(prior.binding, "complete");
		}
		const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
		const entry = yield* path.fromFileUrl(
			new URL(extension === "ts" ? "../store-transfer-worker.ts" : "./store-transfer-worker.js", import.meta.url),
		);
		const encoded = yield* encodeTransferConfiguration(configuration);
		const code = yield* launchRemoteTransfer(configuration.source, configuration.target, {
			dataDirectory,
			transferId: configuration.transferId,
			entry,
			env: { COMMS_TRANSFER_INPUT: Redacted.value(encoded), DATA_DIR: dataDirectory },
		});
		if (code !== 0) return yield* invalid();
		// The scoped launcher has awaited worker and both endpoint guardians before this read.
		const verified = yield* read;
		if (!verified || verified.phase !== "in_progress") return yield* invalid();
		if (configuration.mode === "transfer") {
			yield* writeTransferReceipt({ binding: verified.binding, phase: "complete" });
			return report(verified.binding, "complete");
		}
		return report(verified.binding, "checked");
	});
