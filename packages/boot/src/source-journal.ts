import { decodeRows } from "./decode-rows.ts";
import { Crypto, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Events } from "./events.ts";
import { Batch, SourceRejected, Version, type Change } from "./source-schema.ts";
import { sameImage, type sourceIO } from "./source-io.ts";
import type { TreeEntry } from "./source-tree-publication.ts";

export interface UndoSelection {
	readonly retry?: { readonly family: string; readonly key: string };
	readonly path?: string;
	readonly batch?: string;
	readonly version?: number;
	readonly generation?: number;
}

/** One durable publication, with transient recovery bytes separate from retained undo history. */
export const sourceJournal = Effect.fn("sourceJournal")(function* (io: Effect.Success<ReturnType<typeof sourceIO>>) {
	const sql = yield* SqlClient.SqlClient;
	const crypto = yield* Crypto.Crypto;
	const events = yield* Events;
	const pending = sql`SELECT * FROM source_batches WHERE state = 'publishing'`.pipe(
		decodeRows(Batch),
		Effect.map((rows) => rows[0] ?? null),
	);
	const ready = Effect.gen(function* () {
		const batch = yield* pending;
		if (batch) return yield* new SourceRejected({ code: "publication_pending", path: batch.id });
	});
	const rows = (batch: string) =>
		sql`SELECT path, before, before_sha, before_mode, desired, desired_sha, desired_mode, before_directory, desired_directory FROM source_changes WHERE batch = ${batch} ORDER BY path`.pipe(
			decodeRows(
				Schema.Struct({
					path: Schema.String,
					before_directory: Schema.Literals([0, 1]),
					desired_directory: Schema.Literals([0, 1]),
					before: Schema.NullOr(Schema.Uint8Array),
					before_sha: Schema.NullOr(Schema.String),
					before_mode: Schema.NullOr(Schema.Int),
					desired: Schema.NullOr(Schema.Uint8Array),
					desired_sha: Schema.NullOr(Schema.String),
					desired_mode: Schema.NullOr(Schema.Int),
				}),
			),
			Effect.map((rows) =>
				rows.map((row) => ({
					path: row.path,
					before: {
						content: row.before,
						sha: row.before_sha,
						mode: row.before_mode,
						...(row.before_directory === 1 ? { directory: true as const } : {}),
					},
					desired: {
						content: row.desired,
						sha: row.desired_sha,
						mode: row.desired_mode,
						...(row.desired_directory === 1 ? { directory: true as const } : {}),
					},
				})),
			),
		);
	const begin = (batch: typeof Batch.Type, changes: readonly Change[]) =>
		sql.withTransaction(
			Effect.gen(function* () {
				yield* ready;
				yield* sql`INSERT INTO source_batches ${sql.insert(batch)}`;
				for (const change of changes)
					yield* sql`INSERT INTO source_changes ${sql.insert({ batch: batch.id, path: change.path, before_directory: change.before.directory ? 1 : 0, desired_directory: change.desired.directory ? 1 : 0, before: change.before.content, before_sha: change.before.sha, before_mode: change.before.mode, desired: change.desired.content, desired_sha: change.desired.sha, desired_mode: change.desired.mode })}`;
			}),
		);
	const recordVersions = (batch: typeof Batch.Type, changes: readonly Change[]) =>
		Effect.gen(function* () {
			for (const change of changes) {
				const beforeEligible =
					change.before.sha === null ||
					(change.before.content !== null && change.before.content.byteLength <= 1024 * 1024);
				const desiredEligible =
					change.desired.sha === null ||
					(change.desired.content !== null && change.desired.content.byteLength <= 1024 * 1024);
				yield* sql`INSERT INTO versions ${sql.insert({ batch: batch.id, path: change.path, previous_directory: change.before.directory ? 1 : 0, directory: change.desired.directory ? 1 : 0, agent: batch.agent, at: batch.at, content: desiredEligible ? change.desired.content : null, sha: change.desired.sha, mode: change.desired.mode, previous_content: beforeEligible ? change.before.content : null, previous_sha: change.before.sha, previous_mode: change.before.mode, versioned: beforeEligible && desiredEligible ? 1 : 0, reason: beforeEligible && desiredEligible ? null : "size_limit" })}`;
			}
		});
	const recover = Effect.gen(function* () {
		const batch = yield* pending;
		if (!batch) return null;
		const changes = yield* rows(batch.id);
		if (changes.some((change) => change.before.directory || change.desired.directory))
			yield* io.publishTree(changes, batch.id);
		else {
			// Validate every target before applying the first one; recheck each immediately before replacement.
			for (const change of changes) {
				const current = yield* io.read(change.path);
				if (!sameImage(current, change.before) && !sameImage(current, change.desired))
					return yield* new SourceRejected({ code: "external_conflict", path: change.path });
			}
			for (const [index, change] of changes.entries()) {
				const current = yield* io.read(change.path);
				if (!sameImage(current, change.before) && !sameImage(current, change.desired))
					return yield* new SourceRejected({ code: "external_conflict", path: change.path });
				// Replacing even an already-desired image repeats file and parent fsync after a crash.
				yield* io.replace(change.path, change.desired, `${batch.id}-${index}`);
			}
		}
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* recordVersions(batch, changes);
				for (const change of changes) {
					if (sameImage(change.before, change.desired)) continue;
					yield* events.writeBoot({
						at: batch.at,
						type: "fs.write",
						level: "info",
						actor: batch.agent,
						instance: null,
						generation: 0,
						request_id: null,
						topic: null,
						message_id: null,
						payload: {
							batch: batch.id,
							path: change.path,
							before_sha: change.before.sha,
							sha: change.desired.sha,
							deleted: change.desired.content === null && !change.desired.directory,
						},
					});
				}
				yield* sql`UPDATE source_batches SET state = 'published' WHERE id = ${batch.id}`;
				yield* sql`DELETE FROM source_changes WHERE batch = ${batch.id}`;
			}),
		);
		return batch.id;
	});
	const history = (name: string) =>
		sql`SELECT * FROM versions WHERE path = ${name} ORDER BY id DESC`.pipe(decodeRows(Version));
	const previous = (batch: string) =>
		Effect.gen(function* () {
			yield* ready;
			const versions = yield* sql`SELECT * FROM versions WHERE batch = ${batch} ORDER BY path`.pipe(
				decodeRows(Version),
			);
			if (versions.length === 0) return yield* new SourceRejected({ code: "batch_missing", path: batch });
			for (const version of versions)
				if (version.directory || version.previous_directory)
					return yield* new SourceRejected({ code: "version_unavailable", path: version.path });
			for (const version of versions)
				if (version.previous_sha !== null && version.previous_content === null)
					return yield* new SourceRejected({ code: "version_unavailable", path: version.path });
			return versions.map((version) => ({
				path: version.path,
				content: version.previous_content,
				...(version.previous_mode === null ? {} : { mode: version.previous_mode }),
			}));
		});
	const Selected = Schema.Struct({
		batch: Schema.NullOr(Schema.String),
		version: Schema.NullOr(Schema.Int),
		previous: Schema.Boolean,
		generation: Schema.optional(Schema.Int),
	});
	const Binding = Schema.fromJsonString(Schema.Struct({ request: Schema.String, selected: Selected }));
	// Keep legacy watcher baseline rows out of implicit undo; their retained history stays readable.
	const select = (selection: UndoSelection) =>
		Effect.gen(function* () {
			if (selection.generation !== undefined)
				return { batch: null, version: null, previous: false, generation: selection.generation };
			if (selection.batch !== undefined) return { batch: selection.batch, version: null, previous: true };
			const rows = yield* (
				selection.version !== undefined
					? sql`SELECT * FROM versions WHERE id = ${selection.version}`
					: selection.path !== undefined
						? sql`SELECT * FROM versions WHERE path = ${selection.path} ORDER BY (sha IS NOT previous_sha OR mode IS NOT previous_mode OR directory != previous_directory) DESC,id DESC LIMIT 1`
						: sql`SELECT * FROM versions WHERE (path = 'app' OR path LIKE 'app/%') AND batch != COALESCE((SELECT value FROM settings WHERE key='source.watcher_baseline'),'') ORDER BY id DESC LIMIT 1`
			).pipe(decodeRows(Version));
			const version = rows[0];
			if (!version)
				return yield* new SourceRejected({
					code: "batch_missing",
					path: selection.path ?? String(selection.version ?? "latest"),
				});
			return selection.path === undefined && selection.version === undefined
				? { batch: version.batch, version: null, previous: true }
				: { batch: null, version: version.id, previous: selection.version === undefined };
		});
	const selectedWrites = (selected: typeof Selected.Type) =>
		Effect.gen(function* () {
			if (selected.generation !== undefined)
				return yield* new SourceRejected({ code: "invalid_path", path: "generation" });
			if (selected.batch !== null) return yield* previous(selected.batch);
			const rows = yield* sql`SELECT * FROM versions WHERE id = ${selected.version}`.pipe(decodeRows(Version));
			const version = rows[0];
			if (!version) return yield* new SourceRejected({ code: "batch_missing", path: String(selected.version) });
			if (version.directory || version.previous_directory)
				return yield* new SourceRejected({ code: "version_unavailable", path: version.path });
			const content = selected.previous ? version.previous_content : version.content;
			const sha = selected.previous ? version.previous_sha : version.sha;
			const mode = selected.previous ? version.previous_mode : version.mode;
			if (sha !== null && content === null)
				return yield* new SourceRejected({ code: "version_unavailable", path: version.path });
			return [{ path: version.path, content, ...(mode === null ? {} : { mode }) }];
		});
	const selectUndo = (selection: UndoSelection) =>
		sql.withTransaction(
			Effect.gen(function* () {
				if (!selection.retry) return yield* select(selection);
				const key =
					"source-revert:" +
					Buffer.from(
						yield* crypto.digest(
							"SHA-256",
							new TextEncoder().encode(
								yield* Schema.encodeEffect(
									Schema.fromJsonString(Schema.Struct({ family: Schema.String, key: Schema.String })),
								)(selection.retry),
							),
						),
					).toString("hex");
				const request = yield* Schema.encodeEffect(
					Schema.fromJsonString(
						Schema.Struct({
							path: Schema.NullOr(Schema.String),
							batch: Schema.NullOr(Schema.String),
							version: Schema.NullOr(Schema.Int),
							generation: Schema.optional(Schema.Int),
						}),
					),
				)({
					path: selection.path ?? null,
					batch: selection.batch ?? null,
					version: selection.version ?? null,
					...(selection.generation === undefined ? {} : { generation: selection.generation }),
				});
				const rows = yield* sql`SELECT value FROM settings WHERE key = ${key}`.pipe(
					decodeRows(Schema.Struct({ value: Schema.String })),
				);
				const saved = rows[0] ? yield* Schema.decodeEffect(Binding)(rows[0].value) : null;
				if (saved && saved.request !== request)
					return yield* new SourceRejected({ code: "idempotency_conflict", path: "revert" });
				const selected = saved?.selected ?? (yield* select(selection));

				if (!saved)
					yield* sql`INSERT INTO settings (key,value) VALUES (${key},${yield* Schema.encodeEffect(Binding)({ request, selected })})`;
				return selected;
			}),
		);
	const undo = (selection: UndoSelection) => sql.withTransaction(Effect.flatMap(selectUndo(selection), selectedWrites));
	/** Typed history restores only the selected subtree. The caller overlays it on the current full tree. */
	const treeUndo = (selection: UndoSelection) =>
		sql.withTransaction(
			Effect.gen(function* () {
				yield* ready;
				const selected = yield* selectUndo(selection);
				if (selected.generation !== undefined) return null;
				const chosen =
					selected.batch === null
						? yield* sql`SELECT * FROM versions WHERE id = ${selected.version}`.pipe(decodeRows(Version))
						: [];
				const version = chosen[0];
				if (selected.batch === null && !version)
					return yield* new SourceRejected({ code: "batch_missing", path: String(selected.version) });
				if (version && !version.directory && !version.previous_directory) return null;
				const batch = selected.batch ?? version?.batch;
				if (batch === undefined) return yield* new SourceRejected({ code: "batch_missing", path: "revert" });
				const versions = yield* sql`SELECT * FROM versions WHERE batch = ${batch} ORDER BY path`.pipe(
					decodeRows(Version),
				);
				if (versions.length === 0) return yield* new SourceRejected({ code: "batch_missing", path: batch });
				if (!versions.some((row) => row.directory || row.previous_directory)) return null;
				// A full-tree checkpoint carries unchanged entries for recovery evidence, not permission to undo them.
				const changed = version
					? [version.path]
					: versions
							.filter(
								(row) =>
									row.sha !== row.previous_sha ||
									row.mode !== row.previous_mode ||
									row.directory !== row.previous_directory,
							)
							.map((row) => row.path);
				const roots = changed.filter(
					(name) => !changed.some((parent) => name !== parent && name.startsWith(`${parent}/`)),
				);
				for (const root of roots)
					if (root !== "app" && !root.startsWith("app/"))
						return yield* new SourceRejected({ code: "invalid_path", path: root });
				const entries: TreeEntry[] = [];
				for (const row of versions) {
					if (!roots.some((root) => row.path === root || row.path.startsWith(`${root}/`))) continue;
					const directory = selected.previous ? row.previous_directory : row.directory;
					const content = selected.previous ? row.previous_content : row.content;
					const sha = selected.previous ? row.previous_sha : row.sha;
					const mode = selected.previous ? row.previous_mode : row.mode;
					if (directory)
						entries.push({ path: row.path, image: { directory: true, content: null, sha: null, mode: null } });
					else if (sha !== null) {
						if (content === null) return yield* new SourceRejected({ code: "version_unavailable", path: row.path });
						entries.push({ path: row.path, image: { content, sha, mode } });
					}
				}
				return { roots, entries };
			}),
		);

	// Only immutable history identity is inspected here; resolving/binding the undo happens under SourceFiles' gate.
	const targetsPages = (selection: UndoSelection) =>
		Effect.gen(function* () {
			if (selection.path !== undefined) return selection.path.startsWith("pages/");
			if (selection.version === undefined && selection.batch === undefined) return false;
			const rows = yield* (
				selection.version !== undefined
					? sql`SELECT path FROM versions WHERE id = ${selection.version}`
					: sql`SELECT path FROM versions WHERE batch = ${selection.batch}`
			).pipe(decodeRows(Schema.Struct({ path: Schema.String })));
			return rows.length > 0 && rows.every((row) => row.path.startsWith("pages/"));
		});
	return { ready, begin, recover, history, previous, undo, treeUndo, selectUndo, targetsPages };
});
