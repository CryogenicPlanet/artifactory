import { selectionText, TransferSelection, validateTransferSelection } from "@comms/storage/store-transfer-schema";
import { Effect, FileSystem, Path, Schema } from "effect";

const Migration = Schema.Struct({ migration_id: Schema.Int, name: Schema.String });
const Extension = Schema.Struct({ extension: Schema.String, name: Schema.String, checksum: Schema.String });
const Proof = Schema.Struct({
	extension: Schema.String,
	name: Schema.String,
	sourceChecksum: Schema.String,
	targetChecksum: Schema.String,
});
export const MigrationProof = Schema.Struct({
	selection: TransferSelection,
	initialized_at: Schema.Int,
	epoch: Schema.String,
	generation: Schema.Struct({ n: Schema.Int, entry_file: Schema.String, snapshot_dir: Schema.String }),
	result: Schema.Struct({
		core: Schema.Array(Migration),
		editable: Schema.Array(Migration),
		extensions: Schema.Array(Extension),
		extensionProofs: Schema.Array(Proof),
	}),
	safetyReceipt: Schema.String,
});
export type MigrationProof = typeof MigrationProof.Type;
export class MigrationProofError extends Schema.TaggedError<MigrationProofError>()("MigrationProofError", {
	code: Schema.Literal("transfer_migration_proof_invalid"),
}) {}
const invalid = () => new MigrationProofError({ code: "transfer_migration_proof_invalid" });
const limit = 1024 * 1024;
const hash = (value: string) => /^[0-9a-f]{64}(?![\s\S])/.test(value);
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(value);
const canonical = (input: MigrationProof) =>
	Effect.gen(function* () {
		const value = yield* Schema.decodeUnknownEffect(MigrationProof)(input, { onExcessProperty: "error" });
		const selection = yield* validateTransferSelection(value.selection);
		const path = yield* Path.Path;
		const root = path.join(selection.data_directory, "transfers", selection.transfer_id);
		const safetyId = path.basename(path.dirname(value.safetyReceipt));
		if (
			!Number.isSafeInteger(value.initialized_at) ||
			value.initialized_at < 0 ||
			!hash(value.epoch) ||
			!Number.isSafeInteger(value.generation.n) ||
			value.generation.n < 1 ||
			!uuid(safetyId) ||
			value.safetyReceipt !== path.join(root, "safety", safetyId, "receipt.json") ||
			path.isAbsolute(value.generation.entry_file) ||
			/[\\\x00-\x1f\x7f]/.test(value.generation.entry_file) ||
			value.generation.entry_file.split("/").some((part) => part === "" || part === "." || part === "..") ||
			!path.isAbsolute(value.generation.snapshot_dir) ||
			path.normalize(value.generation.snapshot_dir) !== value.generation.snapshot_dir ||
			/[\x00-\x1f\x7f]/.test(value.generation.snapshot_dir)
		)
			return yield* invalid();
		for (const rows of [value.result.core, value.result.editable])
			if (
				rows.some((row) => !Number.isSafeInteger(row.migration_id) || row.migration_id < 1 || !row.name) ||
				new Set(rows.map((row) => row.migration_id)).size !== rows.length
			)
				return yield* invalid();
		const key = (row: { readonly extension: string; readonly name: string }) =>
			JSON.stringify([row.extension, row.name]);
		for (const rows of [value.result.extensions, value.result.extensionProofs])
			if (
				rows.some((row) => !row.extension || !row.name || row.extension.includes("\0") || row.name.includes("\0")) ||
				new Set(rows.map(key)).size !== rows.length
			)
				return yield* invalid();
		if (
			value.result.extensions.some((row) => !hash(row.checksum)) ||
			value.result.extensionProofs.some((row) => !hash(row.sourceChecksum) || !hash(row.targetChecksum))
		)
			return yield* invalid();
		const compare = (
			a: { readonly extension: string; readonly name: string },
			b: { readonly extension: string; readonly name: string },
		) =>
			Buffer.compare(Buffer.from(a.extension), Buffer.from(b.extension)) ||
			Buffer.compare(Buffer.from(a.name), Buffer.from(b.name));
		return {
			selection,
			initialized_at: value.initialized_at,
			epoch: value.epoch,
			generation: {
				n: value.generation.n,
				entry_file: value.generation.entry_file,
				snapshot_dir: value.generation.snapshot_dir,
			},
			result: {
				core: value.result.core.toSorted((a, b) => a.migration_id - b.migration_id),
				editable: value.result.editable.toSorted((a, b) => a.migration_id - b.migration_id),
				extensions: value.result.extensions.toSorted(compare),
				extensionProofs: value.result.extensionProofs.toSorted(compare),
			},
			safetyReceipt: value.safetyReceipt,
		};
	});
const paths = (selection: TransferSelection) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		yield* validateTransferSelection(selection);
		const root = selection.data_directory;
		if ((yield* fs.realPath(root)) !== root || (yield* fs.stat(root)).type !== "Directory") return yield* invalid();
		const directory = path.join(root, "transfers", selection.transfer_id);
		for (const name of [path.join(root, "transfers"), directory]) {
			const info = yield* fs.stat(name);
			if (info.type !== "Directory" || (info.mode & 0o777) !== 0o700 || (yield* fs.realPath(name)) !== name)
				return yield* invalid();
		}
		return {
			file: path.join(directory, "migration-proof.json"),
			temporary: path.join(directory, "migration-proof.json.next"),
			directory,
		};
	});
const read = (selection: TransferSelection) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const selected = yield* paths(selection);
		// Directory enumeration also detects dangling symlinks, unlike exists/stat.
		const names = yield* fs.readDirectory(selected.directory);
		if (names.includes("migration-proof.json.next")) return yield* invalid();
		if (!names.includes("migration-proof.json")) return undefined;
		const info = yield* fs.stat(selected.file);
		if (
			info.type !== "File" ||
			(info.mode & 0o777) !== 0o600 ||
			info.size > BigInt(limit) ||
			(yield* fs.realPath(selected.file)) !== selected.file
		)
			return yield* invalid();
		const text = yield* fs.readFileString(selected.file);
		if (Buffer.byteLength(text) > limit) return yield* invalid();
		const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MigrationProof))(text, {
			onExcessProperty: "error",
		});
		const value = yield* canonical(decoded);
		if (selectionText(value.selection) !== selectionText(selection)) return yield* invalid();
		return value;
	});
/** Private replay input only. Caller must compare generation/seed evidence and revalidate safetyReceipt. */
export const readMigrationProof = (selection: TransferSelection) => read(selection).pipe(Effect.mapError(invalid));
/** Call only after the migration keeper has returned positive closure proof. Offline owner serializes writers.
 * A partial .next is retained and refused; this artifact cannot activate a target. */
export const writeMigrationProof = (artifact: MigrationProof) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const value = yield* canonical(artifact);
		const text = yield* Schema.encodeEffect(Schema.fromJsonString(MigrationProof))(value);
		if (Buffer.byteLength(text) > limit) return yield* invalid();
		const selected = yield* paths(value.selection);
		const prior = yield* read(value.selection);
		if (prior) {
			const before = yield* Schema.encodeEffect(Schema.fromJsonString(MigrationProof))(prior);
			if (before !== text) return yield* invalid();
			return;
		}
		yield* Effect.scoped(
			Effect.gen(function* () {
				const file = yield* fs.open(selected.temporary, { flag: "wx", mode: 0o600 });
				yield* file.writeAll(new TextEncoder().encode(text));
				yield* file.sync;
			}),
		);
		yield* fs.rename(selected.temporary, selected.file);
		yield* Effect.scoped(fs.open(selected.directory).pipe(Effect.flatMap((directory) => directory.sync)));
		if (!(yield* read(value.selection))) return yield* invalid();
	}).pipe(Effect.mapError(invalid));
