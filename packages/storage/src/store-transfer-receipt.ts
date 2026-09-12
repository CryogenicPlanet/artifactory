import {
	bindingText,
	TransferFileJournal,
	selectionText,
	validateTransferPreparation,
	TransferRejected,
	validateTransferBinding,
} from "./store-transfer-schema.ts";
import { Effect, FileSystem, Path, Schema } from "effect";

const invalid = () => new TransferRejected({ code: "transfer_journal_conflict" });

/** Caller holds the immutable launcher's volume lock. The worker may publish in_progress;
 * only the outer process, after positive closure of every owner, may publish complete. */
export const writeTransferReceipt = (receipt: TransferFileJournal) =>
	Effect.gen(function* () {
		const binding =
			receipt.phase === "preparing"
				? (yield* validateTransferPreparation(receipt)).selection
				: yield* validateTransferBinding(receipt.binding);
		const compatible = (saved: TransferFileJournal) =>
			Effect.gen(function* () {
				const selected =
					saved.phase === "preparing"
						? (yield* validateTransferPreparation(saved)).selection
						: yield* validateTransferBinding(saved.binding);
				if (selectionText(selected) !== selectionText(binding)) return yield* invalid();
				if (
					saved.phase === "preparing" &&
					receipt.phase === "preparing" &&
					(saved.epoch !== receipt.epoch || saved.initialized_at !== receipt.initialized_at)
				)
					return yield* invalid();
				if (
					saved.phase !== "preparing" &&
					receipt.phase !== "preparing" &&
					bindingText(saved.binding) !== bindingText(receipt.binding)
				)
					return yield* invalid();
			});
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const directory = path.join(binding.data_directory, "transfers", binding.transfer_id);
		if (
			(yield* fs.realPath(directory)) !== directory ||
			(yield* fs.realPath(binding.data_directory)) !== binding.data_directory
		)
			return yield* invalid();
		const filename = path.join(directory, "journal.json");
		const temporary = path.join(directory, "journal.json.next");
		const read = (name: string) =>
			Effect.gen(function* () {
				if (!(yield* fs.readDirectory(directory)).includes(path.basename(name))) return undefined;
				if ((yield* fs.realPath(name)) !== name || (yield* fs.stat(name)).type !== "File") return yield* invalid();
				const saved = yield* fs
					.readFileString(name)
					.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TransferFileJournal))),
						Effect.mapError(invalid),
					);
				yield* compatible(saved);
				return saved;
			});
		const prior = yield* read(filename);
		if (prior?.phase === "complete") {
			if (receipt.phase !== "complete") return yield* invalid();
			yield* Effect.scoped(fs.open(filename).pipe(Effect.flatMap((file) => file.sync)));
			yield* Effect.scoped(fs.open(directory).pipe(Effect.flatMap((file) => file.sync)));
			return;
		}
		if (prior === undefined && (receipt.phase !== "preparing" || receipt.sentinel !== "pending"))
			return yield* invalid();
		if (prior?.phase === "preparing") {
			if (
				receipt.phase === "complete" ||
				(receipt.phase === "in_progress" && prior.sentinel !== "ready") ||
				(receipt.phase === "preparing" && prior.sentinel === "ready" && receipt.sentinel !== "ready")
			)
				return yield* invalid();
		} else if (prior !== undefined && receipt.phase === "preparing") return yield* invalid();
		// A failed rename can leave our own exclusive temporary. Verify its complete binding
		// before removing it; never interpret a temporary complete phase as activation.
		const staged = yield* read(temporary);
		if (staged !== undefined) {
			if (
				prior?.phase === "preparing" &&
				staged.phase === "preparing" &&
				(prior.epoch !== staged.epoch || prior.initialized_at !== staged.initialized_at)
			)
				return yield* invalid();
			yield* fs.remove(temporary);
		}
		yield* Effect.uninterruptible(
			Effect.gen(function* () {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
						yield* file.writeAll(
							new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(TransferFileJournal))(receipt)),
						);
						yield* file.sync;
					}),
				);
				yield* fs.rename(temporary, filename);
				yield* Effect.scoped(fs.open(directory).pipe(Effect.flatMap((file) => file.sync)));
			}),
		);
	});
