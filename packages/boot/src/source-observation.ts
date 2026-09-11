import { Crypto, DateTime, Effect, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { sourceIO, sameImage } from "./source-io.ts";
import { sourceJournal } from "./source-journal.ts";
import { SourceRejected, Version, type Change, type Image } from "./source-schema.ts";
import { readSourceInventory } from "./source-tree.ts";

export interface Observation {
	readonly files: ReadonlyArray<{ readonly path: string; readonly image: Image }>;
	readonly changes: readonly Change[];
	readonly directories: readonly string[];
	readonly fingerprint: string;
}

/** Captures external edits without rewriting them. Call under SourceFiles' gate. */
export const sourceObservation = Effect.fn("sourceObservation")(function* (dataDirectory: string) {
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const sql = yield* SqlClient.SqlClient;
	const io = yield* sourceIO(dataDirectory);
	const inventory = Effect.gen(function* () {
		const tree = yield* readSourceInventory(path.join(dataDirectory, "app"));
		const files = yield* Effect.forEach(tree.files, (file) =>
			Effect.map(io.image(file.content, file.mode ?? null), (image) => ({ path: file.path, image })),
		);
		return { files, directories: tree.directories };
	});
	const fingerprint = (tree: { readonly files: Observation["files"]; readonly directories: readonly string[] }) =>
		crypto
			.digest(
				"SHA-256",
				new TextEncoder().encode(
					JSON.stringify([tree.directories, tree.files.map((file) => [file.path, file.image.sha, file.image.mode])]),
				),
			)
			.pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
	const capture = Effect.gen(function* () {
		if ((yield* sql`SELECT key FROM settings WHERE key='source.watcher_baseline'`).length === 0)
			return yield* new SourceRejected({ code: "watcher_baseline_missing", path: "app" });
		const { files, directories } = yield* inventory;
		const previous =
			yield* sql`SELECT v.* FROM versions v WHERE (v.path='app' OR v.path LIKE 'app/%') AND v.id=(SELECT MAX(n.id) FROM versions n WHERE n.path=v.path) ORDER BY v.path`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Version))),
			);
		const before = new Map<string, Image>(
			previous.map((row) => [
				row.path,
				{ content: row.content, sha: row.sha, mode: row.mode, ...(row.directory === 1 ? { directory: true } : {}) },
			]),
		);
		// Ordinary API publication creates parent directories without separate directory versions.
		// Infer only parents of a retained file-presence version; a newer explicit tombstone wins.
		const presence =
			yield* sql`SELECT v.path,v.id,v.batch FROM versions v WHERE v.path LIKE 'app/%' AND (v.sha IS NOT NULL OR v.previous_sha IS NOT NULL) AND v.id=(SELECT MAX(n.id) FROM versions n WHERE n.path=v.path AND (n.sha IS NOT NULL OR n.previous_sha IS NOT NULL))`.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Array(Schema.Struct({ path: Schema.String, id: Schema.Int, batch: Schema.String })),
					),
				),
			);
		const recorded = new Map(previous.map((row) => [row.path, row]));
		for (const file of presence) {
			let parent = path.dirname(file.path);
			while (parent === "app" || parent.startsWith("app/")) {
				const explicit = recorded.get(parent);
				if (!explicit || (explicit.id < file.id && explicit.batch !== file.batch))
					before.set(parent, { directory: true, content: null, sha: null, mode: null });
				if (parent === "app") break;
				parent = path.dirname(parent);
			}
		}
		const desired = new Map<string, Image>(files.map((file) => [file.path, file.image]));
		for (const name of directories) desired.set(name, { content: null, sha: null, mode: null, directory: true });
		const absent = yield* io.image(null, null);
		const all: Change[] = [];
		for (const name of [...new Set([...before.keys(), ...desired.keys()])].sort()) {
			const old = before.get(name) ?? absent;
			const next = desired.get(name) ?? absent;
			all.push({ path: name, before: old, desired: next });
		}
		const changed = all.filter((entry) => !sameImage(entry.before, entry.desired));
		const changes = changed.some((entry) => entry.before.directory || entry.desired.directory) ? all : changed;
		return { files, directories, changes, fingerprint: yield* fingerprint({ files, directories }) };
	});
	const validate = (observed: Observation) =>
		Effect.gen(function* () {
			if ((yield* fingerprint(yield* inventory)) !== observed.fingerprint)
				return yield* new SourceRejected({ code: "external_conflict", path: "app" });
		});
	return { inventory, capture, validate };
});

/** Only fresh seeding calls this, before source preparation and under the source gate.
 * An existing deployment without a baseline must never adopt arbitrary current bytes. */
export const initializeSourceBaseline = Effect.fn("initializeSourceBaseline")(function* (
	dataDirectory: string,
	expectedDirectory?: string,
) {
	const sql = yield* SqlClient.SqlClient;
	if ((yield* sql`SELECT key FROM settings WHERE key='source.watcher_baseline'`).length > 0) return;
	const crypto = yield* Crypto.Crypto;
	const io = yield* sourceIO(dataDirectory);
	const observer = yield* sourceObservation(dataDirectory);
	const journal = yield* sourceJournal(io);
	const { files, directories } = yield* observer.inventory;
	if (expectedDirectory !== undefined) {
		const expected = yield* readSourceInventory(expectedDirectory);
		const expectedFiles = yield* Effect.forEach(expected.files, (file) =>
			Effect.map(io.image(file.content, file.mode ?? null), (image) => ({ path: file.path, image })),
		);
		if (
			directories.length !== expected.directories.length ||
			directories.some((name, index) => name !== expected.directories[index]) ||
			files.length !== expectedFiles.length ||
			files.some((file, index) => {
				const other = expectedFiles[index];
				return (
					other === undefined ||
					file.path !== other.path ||
					file.image.sha !== other.image.sha ||
					((file.image.mode ?? 0) & 0o111) > 0 !== ((other.image.mode ?? 0) & 0o111) > 0
				);
			})
		)
			return yield* new SourceRejected({ code: "external_conflict", path: "app" });
	}
	yield* sql.withTransaction(
		Effect.gen(function* () {
			if ((yield* sql`SELECT key FROM settings WHERE key='source.watcher_baseline'`).length > 0) return;
			const id = yield* crypto.randomUUIDv4;
			yield* journal.recordObserved(
				{
					id,
					lock_id: null,
					agent: "boot",
					at: (yield* DateTime.nowAsDate).getTime(),
					state: "published",
				},
				[
					...directories.map((name): Change => ({
						path: name,
						before: { content: null, sha: null, mode: null, directory: true },
						desired: { content: null, sha: null, mode: null, directory: true },
					})),
					...files.map((file) => ({ path: file.path, before: file.image, desired: file.image })),
				],
			);
			yield* sql`INSERT INTO settings(key,value) VALUES('source.watcher_baseline',${id})`;
		}),
	);
});
