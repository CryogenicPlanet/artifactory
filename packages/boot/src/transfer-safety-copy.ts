import { Crypto, Effect, FileSystem, Path, Schema } from "effect";
import type { FileStore } from "@comms/storage/store";

const Suffix = Schema.Literals(["", "-wal", "-shm", "-journal"]);
const Receipt = Schema.Struct({
	version: Schema.Literal(1),
	engine: Schema.Literal("sqlite"),
	transfer_id: Schema.String,
	store_id: Schema.String,
	attempt: Schema.String,
	source: Schema.Struct({ boot: Schema.String, app: Schema.String }),
	files: Schema.Array(
		Schema.Struct({ store: Schema.Literals(["boot", "app"]), suffix: Suffix, bytes: Schema.Int, hash: Schema.String }),
	),
});
export type TransferSafetyReceipt = typeof Receipt.Type;
export class TransferSafetyError extends Schema.TaggedError<TransferSafetyError>()("TransferSafetyError", {
	code: Schema.Literal("transfer_safety_copy_invalid"),
}) {}
const invalid = () => new TransferSafetyError({ code: "transfer_safety_copy_invalid" });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const suffixes = ["", "-wal", "-shm", "-journal"] as const;

/** Offline opaque before-images, using the same closed-file rule as restore-before-image.
 * Caller holds the root lock and proves ALL source SQL scopes/keepers closed, including its own
 * preflight connections. Close preflight scopes before capture; reopen only after receipt publication.
 * No database is opened, no source intent is written, and no partial/failed artifact is removed. */
export const sqliteTransferSafetyCopy = <E, R>(options: {
	readonly dataDirectory: string;
	readonly transferId: string;
	readonly storeId: string;
	readonly source: { readonly boot: FileStore; readonly app: FileStore };
	readonly assertAllClosed: Effect.Effect<void, E, R>;
}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const root = yield* fs.realPath(options.dataDirectory);
		if (
			!uuid.test(options.transferId) ||
			!uuid.test(options.storeId) ||
			suffixes.some(
				(suffix) =>
					options.source.boot.filename + suffix === options.source.app.filename ||
					options.source.app.filename + suffix === options.source.boot.filename,
			)
		)
			return yield* invalid();
		const source = { boot: options.source.boot.filename, app: options.source.app.filename };
		for (const selected of Object.values(source)) {
			const relative = path.relative(root, selected);
			if (
				!path.isAbsolute(selected) ||
				relative === "" ||
				relative === ".." ||
				relative.startsWith(`..${path.sep}`) ||
				path.isAbsolute(relative) ||
				(yield* fs.realPath(selected)) !== selected ||
				(yield* fs.stat(selected)).type !== "File"
			)
				return yield* invalid();
		}
		const directory = path.join(root, "transfers", options.transferId, "safety");
		const sync = (filename: string) => Effect.scoped(fs.open(filename).pipe(Effect.flatMap((file) => file.sync)));
		const hash = (bytes: Uint8Array) =>
			crypto.digest("SHA-256", bytes).pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
		const regular = (filename: string) =>
			Effect.gen(function* () {
				const entries = yield* fs.readDirectory(path.dirname(filename));
				if (!entries.includes(path.basename(filename))) {
					if ((yield* fs.readLink(filename).pipe(Effect.result))._tag === "Success") return yield* invalid();
					return false;
				}
				if ((yield* fs.realPath(filename)) !== filename || (yield* fs.stat(filename)).type !== "File")
					return yield* invalid();
				return true;
			});
		const verify = (receiptPath: string) =>
			Effect.gen(function* () {
				if (
					path.basename(receiptPath) !== "receipt.json" ||
					path.dirname(path.dirname(receiptPath)) !== directory ||
					!(yield* regular(receiptPath))
				)
					return yield* invalid();
				const receipt = yield* fs
					.readFileString(receiptPath)
					.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Receipt))), Effect.mapError(invalid));
				if (
					receipt.transfer_id !== options.transferId ||
					receipt.store_id !== options.storeId ||
					!uuid.test(receipt.attempt) ||
					path.basename(path.dirname(receiptPath)) !== receipt.attempt ||
					receipt.source.boot !== source.boot ||
					receipt.source.app !== source.app ||
					receipt.files.length < 2 ||
					receipt.files.length > 8
				)
					return yield* invalid();
				const names = new Set<string>();
				for (const file of receipt.files) {
					const name = `${file.store}.db${file.suffix}`;
					if (
						names.has(name) ||
						!Number.isSafeInteger(file.bytes) ||
						file.bytes < 0 ||
						!/^[a-f0-9]{64}$/.test(file.hash)
					)
						return yield* invalid();
					names.add(name);
					const filename = path.join(path.dirname(receiptPath), name);
					if (!(yield* regular(filename))) return yield* invalid();
					const bytes = yield* fs.readFile(filename);
					if (bytes.byteLength !== file.bytes || (yield* hash(bytes)) !== file.hash) return yield* invalid();
				}
				if (!names.has("boot.db") || !names.has("app.db")) return yield* invalid();
				const entries = yield* fs.readDirectory(path.dirname(receiptPath));
				if (entries.length !== names.size + 1 || entries.some((entry) => entry !== "receipt.json" && !names.has(entry)))
					return yield* invalid();
				return receipt;
			});
		const capture = Effect.gen(function* () {
			yield* options.assertAllClosed;
			// Each new attempt is exclusive; an interrupted attempt remains available for diagnosis.
			for (const parent of [path.join(root, "transfers"), path.dirname(directory), directory]) {
				const existing = (yield* fs.readDirectory(path.dirname(parent))).includes(path.basename(parent));
				if (!existing) yield* fs.makeDirectory(parent, { mode: 0o700 });
				if ((yield* fs.realPath(parent)) !== parent || (yield* fs.stat(parent)).type !== "Directory")
					return yield* invalid();
			}
			const attempt = yield* crypto.randomUUIDv4;
			const destination = path.join(directory, attempt);
			yield* fs.makeDirectory(destination, { mode: 0o700 });
			const files: Array<TransferSafetyReceipt["files"][number]> = [];
			for (const store of ["boot", "app"] as const)
				for (const suffix of suffixes) {
					const filename = `${source[store]}${suffix}`;
					if (!(yield* regular(filename))) {
						if (suffix === "") return yield* invalid();
						continue;
					}
					const bytes = yield* fs.readFile(filename);
					const output = path.join(destination, `${store}.db${suffix}`);
					yield* fs.writeFile(output, bytes, { flag: "wx", mode: 0o600 });
					yield* sync(output);
					files.push({ store, suffix, bytes: bytes.byteLength, hash: yield* hash(bytes) });
				}
			yield* options.assertAllClosed;
			const receipt: TransferSafetyReceipt = {
				version: 1,
				engine: "sqlite",
				transfer_id: options.transferId,
				store_id: options.storeId,
				attempt,
				source,
				files,
			};
			const receiptPath = path.join(destination, "receipt.json");
			yield* fs.writeFileString(receiptPath, yield* Schema.encodeEffect(Schema.fromJsonString(Receipt))(receipt), {
				flag: "wx",
				mode: 0o600,
			});
			for (const name of [
				receiptPath,
				destination,
				directory,
				path.dirname(directory),
				path.dirname(path.dirname(directory)),
				root,
			])
				yield* sync(name);
			yield* verify(receiptPath);
			return { path: receiptPath, receipt };
		});
		return { capture, verify };
	});
