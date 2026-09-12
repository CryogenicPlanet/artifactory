import {
	TransferFileJournal,
	validateTransferBinding,
	validateTransferSelection,
	type TransferBinding,
	type TransferSelection,
} from "@comms/storage/store-transfer-schema";
import type { Store } from "@comms/storage/store";
import { Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { EventError } from "./events.ts";
const incomplete = () => new EventError({ code: "store_transfer_incomplete" });

/** Match only immutable boot selection. Verified restore may subsequently move the app database. */
export const transferBootMatches = (target: TransferSelection["target"], boot: Store) =>
	Effect.gen(function* () {
		if (boot._tag !== "file") {
			const url = yield* Effect.try({ try: () => new URL(Redacted.value(boot.url)), catch: incomplete });
			const engine = boot._tag === "postgres" ? "pg" : "mysql";
			return (
				target.engine === engine &&
				target.boot === boot.database &&
				target.endpoint === `${url.hostname.toLowerCase()}:${url.port || (engine === "pg" ? "5432" : "3306")}`
			);
		}
		if (target.engine !== "sqlite" || target.endpoint !== null || target.boot !== boot.filename) return false;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const parent = yield* fs.realPath(path.dirname(boot.filename));
		if (path.join(parent, path.basename(boot.filename)) !== boot.filename) return yield* incomplete();
		if ((yield* fs.exists(boot.filename)) && (yield* fs.realPath(boot.filename)) !== boot.filename)
			return yield* incomplete();
		return true;
	});

/** Admission is read before any SQL client can create an apparently fresh target store.
 * Unknown journals fail closed. Unretired source boot selection is not the target. */
export const readTransferAdmission = (options: { readonly dataDirectory: string; readonly boot: Store }) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const directory = yield* fs.realPath(options.dataDirectory);
		const parent = path.join(directory, "transfers");
		if (!(yield* fs.readDirectory(directory)).includes("transfers")) return [];
		if (
			directory !== path.resolve(options.dataDirectory) ||
			(yield* fs.realPath(parent)) !== parent ||
			(yield* fs.stat(parent)).type !== "Directory"
		)
			return yield* incomplete();
		const matched: TransferBinding[] = [];
		for (const name of yield* fs.readDirectory(parent)) {
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(name))
				return yield* incomplete();
			const folder = path.join(parent, name);
			if ((yield* fs.realPath(folder)) !== folder || (yield* fs.stat(folder)).type !== "Directory")
				return yield* incomplete();
			// Owner reservation may create this directory before preparation is acknowledged.
			// Neither an absent journal nor a .next file authorizes target DDL.
			if (!(yield* fs.readDirectory(folder)).includes("journal.json")) continue;
			const filename = path.join(folder, "journal.json");
			const stat = yield* fs.stat(filename);
			if (stat.type !== "File" || stat.size > 32768 || (yield* fs.realPath(filename)) !== filename)
				return yield* incomplete();
			const journal = yield* fs
				.readFileString(filename)
				.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TransferFileJournal))));
			const selection = yield* journal.phase === "preparing"
				? validateTransferSelection(journal.selection)
				: validateTransferBinding(journal.binding);
			if (selection.transfer_id !== name || selection.data_directory !== directory) return yield* incomplete();
			if (!(yield* transferBootMatches(selection.target, options.boot))) continue;
			if (journal.phase !== "complete") return yield* incomplete();
			if (options.boot._tag === "file" && !(yield* fs.exists(options.boot.filename))) return yield* incomplete();
			matched.push(yield* validateTransferBinding(journal.binding));
		}
		return matched;
	}).pipe(Effect.mapError(incomplete));
