import { Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
export class RestoreBeforeImageError extends Schema.TaggedError<RestoreBeforeImageError>()("RestoreBeforeImageError", {
	code: Schema.Literal("restore_before_image_invalid"),
}) {}

const Suffix = Schema.Literals(["", "-wal", "-shm", "-journal"]);
export const RestoreBeforeImage = Schema.Struct({
	version: Schema.Literal(1),
	storeId: Schema.String,
	filename: Schema.String,
	artifact: Schema.String,
	files: Schema.Array(Schema.Struct({ suffix: Suffix, bytes: Schema.Int, hash: Schema.String })),
});
export type RestoreBeforeImage = typeof RestoreBeforeImage.Type;
const suffixes = ["", "-wal", "-shm", "-journal"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalid = () => new RestoreBeforeImageError({ code: "restore_before_image_invalid" });

/** Opaque SQLite bytes only. Caller owns writer closure and the restore operation gate.
 * Commit record with the restore phase in one boot transaction, after prepare completes.
 * Rollback leaves opaque files private (0600); they are never authorized for launch here. */
export const restoreBeforeImage = (dataDirectory: string, filename: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const sql = yield* SqlClient.SqlClient;
		const root = yield* fs.realPath(dataDirectory);
		const parent = yield* fs.realPath(path.dirname(filename));
		const selected = path.join(parent, path.basename(filename));
		const directory = path.join(root, "restore-before");
		if (selected !== path.join(root, "comms.db") && selected !== path.join(root, "store", "comms.db"))
			return yield* invalid();
		const sync = (name: string) => Effect.scoped(fs.open(name).pipe(Effect.flatMap((file) => file.sync)));
		const regular = (name: string, type: "File" | "Directory") =>
			Effect.gen(function* () {
				if (!(yield* fs.readDirectory(path.dirname(name))).includes(path.basename(name))) {
					if ((yield* fs.exists(name)) || (yield* fs.readLink(name).pipe(Effect.result))._tag === "Success")
						return yield* invalid();
					return false;
				}
				if ((yield* fs.realPath(name)) !== name || (yield* fs.stat(name)).type !== type) return yield* invalid();
				return true;
			});
		const validate = (value: unknown, bindFilename = true) =>
			Effect.gen(function* () {
				const manifest = yield* Schema.decodeUnknownEffect(RestoreBeforeImage)(value, {
					onExcessProperty: "error",
				}).pipe(Effect.mapError(invalid));
				if (
					!uuid.test(manifest.storeId) ||
					!uuid.test(manifest.artifact) ||
					(bindFilename && manifest.filename !== selected) ||
					!path.isAbsolute(manifest.filename) ||
					path.normalize(manifest.filename) !== manifest.filename ||
					path.basename(manifest.filename) !== "comms.db" ||
					manifest.filename.includes("\0") ||
					manifest.files.length > 4 ||
					(manifest.files.length > 0 && manifest.files[0]?.suffix !== "") ||
					new Set(manifest.files.map((file) => file.suffix)).size !== manifest.files.length ||
					manifest.files.some(
						(file) => file.bytes < 0 || !Number.isSafeInteger(file.bytes) || !/^[0-9a-f]{64}$/.test(file.hash),
					)
				)
					return yield* invalid();
				return manifest;
			});
		const hash = (bytes: Uint8Array) =>
			crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
		const read = (proofId: string) =>
			Effect.gen(function* () {
				const rows = yield* sql`SELECT value FROM settings WHERE key=${`restore-before:${proofId}`}`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
				);
				if (!rows[0]) return null;
				const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(rows[0].value).pipe(
					Effect.mapError(invalid),
				);
				return yield* validate(value);
			});
		const record = (proofId: string, manifest: RestoreBeforeImage) =>
			Effect.gen(function* () {
				const checked = yield* validate(manifest);
				const saved = yield* read(proofId);
				const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RestoreBeforeImage))(checked);
				if (saved) {
					if ((yield* Schema.encodeEffect(Schema.fromJsonString(RestoreBeforeImage))(saved)) !== encoded)
						return yield* invalid();
					return;
				}
				yield* sql`INSERT INTO settings(key,value) VALUES(${`restore-before:${proofId}`},${encoded})`;
			});
		const prepare = (storeId: string) =>
			Effect.uninterruptible(
				Effect.gen(function* () {
					if (!uuid.test(storeId)) return yield* invalid();
					const present: (typeof Suffix.Type)[] = [];
					for (const suffix of suffixes) if (yield* regular(`${selected}${suffix}`, "File")) present.push(suffix);
					if (present.length > 0 && present[0] !== "") return yield* invalid();
					if (!(yield* regular(directory, "Directory"))) yield* fs.makeDirectory(directory, { mode: 0o700 });
					yield* fs.chmod(directory, 0o700);
					yield* sync(root);
					const artifact = yield* crypto.randomUUIDv4;
					const destination = path.join(directory, artifact);
					yield* fs.makeDirectory(destination, { mode: 0o700 });
					const files: Array<RestoreBeforeImage["files"][number]> = [];
					for (const suffix of present) {
						const target = path.join(destination, `comms.db${suffix}`);
						yield* fs.copyFile(`${selected}${suffix}`, target);
						yield* fs.chmod(target, 0o600);
						yield* sync(target);
						const bytes = yield* fs.readFile(target);
						files.push({ suffix, bytes: bytes.length, hash: yield* hash(bytes) });
					}
					yield* sync(destination);
					yield* sync(directory);
					return { version: 1 as const, storeId, filename: selected, artifact, files };
				}),
			);
		const rollback = (proofId: string, storeId: string) =>
			Effect.uninterruptible(
				Effect.gen(function* () {
					const manifest = yield* read(proofId);
					if (!manifest || manifest.storeId !== storeId) return yield* invalid();
					const artifact = path.join(directory, manifest.artifact);
					if (!(yield* regular(directory, "Directory")) || !(yield* regular(artifact, "Directory")))
						return yield* invalid();
					const entries = yield* fs.readDirectory(artifact);
					if (entries.length !== manifest.files.length) return yield* invalid();
					// Validate the complete protected set before touching even a live sidecar.
					for (const file of manifest.files) {
						const name = path.join(artifact, `comms.db${file.suffix}`);
						if (!(yield* regular(name, "File"))) return yield* invalid();
						const bytes = yield* fs.readFile(name);
						if (bytes.length !== file.bytes || (yield* hash(bytes)) !== file.hash) return yield* invalid();
					}
					for (const suffix of suffixes) yield* regular(`${selected}${suffix}`, "File");
					// Fixed sibling staging names belong solely to this committed artifact. A crash can retry.
					for (const file of manifest.files) {
						const temporary = `${selected}.restore-before-${manifest.artifact}${file.suffix}`;
						if (yield* regular(temporary, "File")) yield* fs.remove(temporary);
						yield* fs.copyFile(path.join(artifact, `comms.db${file.suffix}`), temporary);
						yield* fs.chmod(temporary, 0o600);
						yield* sync(temporary);
					}
					for (const suffix of suffixes) {
						if (manifest.files.some((file) => file.suffix === suffix))
							yield* fs.rename(`${selected}.restore-before-${manifest.artifact}${suffix}`, `${selected}${suffix}`);
						else yield* fs.remove(`${selected}${suffix}`, { force: true });
					}
					yield* sync(parent);
				}),
			);
		// Only never-recorded preparation is reclaimed. Committed before-images have no expiry policy here.
		const recoverUnrecorded = Effect.uninterruptible(
			Effect.gen(function* () {
				const rows = yield* sql`SELECT value FROM settings WHERE key LIKE 'restore-before:%'`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
				);
				const referenced = new Set<string>();
				for (const row of rows) {
					const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(row.value).pipe(
						Effect.mapError(invalid),
					);
					// Relocated historical stores still retain their artifacts; no filesystem path comes from this field.
					referenced.add((yield* validate(value, false)).artifact);
				}
				if (!(yield* regular(directory, "Directory"))) return;
				const unrecorded: string[] = [];
				for (const entry of yield* fs.readDirectory(directory)) {
					const artifact = path.join(directory, entry);
					if (!uuid.test(entry) || !(yield* regular(artifact, "Directory"))) return yield* invalid();
					for (const name of yield* fs.readDirectory(artifact)) {
						if (
							!suffixes.some((suffix) => name === `comms.db${suffix}`) ||
							!(yield* regular(path.join(artifact, name), "File"))
						)
							return yield* invalid();
					}
					if (!referenced.has(entry)) unrecorded.push(artifact);
				}
				// Validate every reference and candidate first, so corruption cannot cause partial reclamation.
				for (const artifact of unrecorded) yield* fs.remove(artifact, { recursive: true });
				yield* sync(directory);
			}),
		);
		return { prepare, record, read, rollback, recoverUnrecorded };
	});
