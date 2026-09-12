import {
	bindingText,
	TransferReceipt,
	TransferRejected,
	validateTransferBinding,
} from "@comms/storage/store-transfer-schema";
import { Effect, FileSystem, Path, Schema } from "effect";

const invalid = () => new TransferRejected({ code: "transfer_journal_conflict" });

/** Caller holds the immutable launcher's volume lock. The worker may publish in_progress;
 * only the outer process, after positive closure of every owner, may publish complete. */
export const writeTransferReceipt = (receipt: TransferReceipt) =>
	Effect.gen(function* () {
		const binding = yield* validateTransferBinding(receipt.binding);
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
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TransferReceipt))),
						Effect.mapError(invalid),
					);
				if (bindingText(saved.binding) !== bindingText(binding)) return yield* invalid();
				return saved;
			});
		const prior = yield* read(filename);
		if (prior?.phase === "complete") {
			if (receipt.phase !== "complete") return yield* invalid();
			yield* Effect.scoped(fs.open(filename).pipe(Effect.flatMap((file) => file.sync)));
			yield* Effect.scoped(fs.open(directory).pipe(Effect.flatMap((file) => file.sync)));
			return;
		}
		if (prior === undefined && receipt.phase === "complete") return yield* invalid();
		// A failed rename can leave our own exclusive temporary. Verify its complete binding
		// before removing it; never interpret a temporary complete phase as activation.
		if (yield* read(temporary)) yield* fs.remove(temporary);
		yield* Effect.uninterruptible(
			Effect.gen(function* () {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
						yield* file.writeAll(
							new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(TransferReceipt))(receipt)),
						);
						yield* file.sync;
					}),
				);
				yield* fs.rename(temporary, filename);
				yield* Effect.scoped(fs.open(directory).pipe(Effect.flatMap((file) => file.sync)));
			}),
		);
	});
