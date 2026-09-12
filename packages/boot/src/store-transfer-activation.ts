import { transferBootMatches } from "./store-transfer-preparation.ts";
import {
	bindingText,
	TransferJournal,
	TransferReceipt,
	validateTransferBinding,
	type TransferBinding,
} from "@comms/storage/store-transfer-schema";
import type { Store } from "@comms/storage/store";
import { Effect, FileSystem, Path, Schema } from "effect";
import { EventError } from "./events.ts";

const incomplete = () => new EventError({ code: "store_transfer_incomplete" });

/** SQL completion is not process closure. Only the immutable parent's matching receipt
 * activates a transferred board. The historical app name may later change through restore;
 * ordinary store identity recovery remains responsible for the current app selection. */
export const assertTransferActivation = (
	rows: ReadonlyArray<{ readonly key: string; readonly value: string }>,
	options: {
		readonly dataDirectory: string;
		readonly boot: Store;
		readonly admissions?: ReadonlyArray<TransferBinding>;
	},
) =>
	Effect.gen(function* () {
		const value = (key: string) => rows.find((row) => row.key === key)?.value;
		const state = value("transfer_state");
		const raw = value("transfer_journal");
		if (state === undefined && raw === undefined && (options.admissions?.length ?? 0) === 0) return;
		if (state !== "complete" || raw === undefined || raw.length > 32768) return yield* incomplete();
		const journal = yield* Schema.decodeEffect(Schema.fromJsonString(TransferJournal))(raw);
		const binding = yield* validateTransferBinding(journal.binding);
		if (
			options.admissions !== undefined &&
			options.admissions.filter((entry) => bindingText(entry) === bindingText(binding)).length !== 1
		)
			return yield* incomplete();
		if (journal.phase !== "complete" || binding.store_id !== value("app_store_id")) return yield* incomplete();
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const directory = yield* fs.realPath(options.dataDirectory);
		if (directory !== path.resolve(options.dataDirectory) || directory !== binding.data_directory)
			return yield* incomplete();
		if (!(yield* transferBootMatches(binding.target, options.boot))) return yield* incomplete();
		const parent = path.join(directory, "transfers");
		const folder = path.join(parent, binding.transfer_id);
		const filename = path.join(folder, "journal.json");
		for (const name of [parent, folder]) {
			if ((yield* fs.realPath(name)) !== name || (yield* fs.stat(name)).type !== "Directory")
				return yield* incomplete();
		}
		const stat = yield* fs.stat(filename);
		if (stat.type !== "File" || stat.size > 32768 || (yield* fs.realPath(filename)) !== filename)
			return yield* incomplete();
		const receipt = yield* fs
			.readFileString(filename)
			.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TransferReceipt))));
		if (receipt.phase !== "complete" || bindingText(receipt.binding) !== bindingText(binding))
			return yield* incomplete();
	}).pipe(Effect.mapError(incomplete));
