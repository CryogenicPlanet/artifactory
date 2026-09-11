import { Crypto, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Batch, SourceRejected, Version, type Change } from "./source-schema.ts";
import { sameImage, type sourceIO } from "./source-io.ts";

export interface UndoSelection {
	readonly retry?: { readonly family: string; readonly key: string };
	readonly path?: string;
	readonly batch?: string;
	readonly version?: number;
}

/** One durable publication, with transient recovery bytes separate from retained undo history. */
export const sourceJournal = Effect.fn("sourceJournal")(function* (io: Effect.Success<ReturnType<typeof sourceIO>>) {
	const sql = yield* SqlClient.SqlClient;
	const crypto = yield* Crypto.Crypto;
	const pending = sql`SELECT * FROM source_batches WHERE state = 'publishing'`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Batch))),
		Effect.map((rows) => rows[0] ?? null),
	);
	const ready = Effect.gen(function* () {
		const batch = yield* pending;
		if (batch) return yield* new SourceRejected({ code: "publication_pending", path: batch.id });
	});
	const rows = (batch: string) =>
		sql`SELECT path, before, before_sha, before_mode, desired, desired_sha, desired_mode FROM source_changes WHERE batch = ${batch} ORDER BY path`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({
							path: Schema.String,
							before: Schema.NullOr(Schema.Uint8Array),
							before_sha: Schema.NullOr(Schema.String),
							before_mode: Schema.NullOr(Schema.Int),
							desired: Schema.NullOr(Schema.Uint8Array),
							desired_sha: Schema.NullOr(Schema.String),
							desired_mode: Schema.NullOr(Schema.Int),
						}),
					),
				),
			),
			Effect.map((rows) =>
				rows.map((row) => ({
					path: row.path,
					before: { content: row.before, sha: row.before_sha, mode: row.before_mode },
					desired: { content: row.desired, sha: row.desired_sha, mode: row.desired_mode },
				})),
			),
		);
	const begin = (batch: typeof Batch.Type, changes: readonly Change[]) =>
		sql.withTransaction(
			Effect.gen(function* () {
				yield* ready;
				yield* sql`INSERT INTO source_batches ${sql.insert(batch)}`;
				for (const change of changes)
					yield* sql`INSERT INTO source_changes ${sql.insert({ batch: batch.id, path: change.path, before: change.before.content, before_sha: change.before.sha, before_mode: change.before.mode, desired: change.desired.content, desired_sha: change.desired.sha, desired_mode: change.desired.mode })}`;
			}),
		);
	const recover = Effect.gen(function* () {
		const batch = yield* pending;
		if (!batch) return null;
		const changes = yield* rows(batch.id);
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
		yield* sql.withTransaction(
			Effect.gen(function* () {
				for (const change of changes) {
					const beforeEligible = (change.before.content?.byteLength ?? 0) <= 1024 * 1024;
					const desiredEligible = (change.desired.content?.byteLength ?? 0) <= 1024 * 1024;
					yield* sql`INSERT INTO versions ${sql.insert({ batch: batch.id, path: change.path, agent: batch.agent, at: batch.at, content: desiredEligible ? change.desired.content : null, sha: change.desired.sha, mode: change.desired.mode, previous_content: beforeEligible ? change.before.content : null, previous_sha: change.before.sha, previous_mode: change.before.mode, versioned: beforeEligible && desiredEligible ? 1 : 0, reason: beforeEligible && desiredEligible ? null : "size_limit" })}`;
				}
				yield* sql`UPDATE source_batches SET state = 'published' WHERE id = ${batch.id}`;
				yield* sql`DELETE FROM source_changes WHERE batch = ${batch.id}`;
			}),
		);
		return batch.id;
	});
	const history = (name: string) =>
		sql`SELECT * FROM versions WHERE path = ${name} ORDER BY id DESC`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Version))),
		);
	const previous = (batch: string) =>
		Effect.gen(function* () {
			yield* ready;
			const versions = yield* sql`SELECT * FROM versions WHERE batch = ${batch} ORDER BY path`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Version))),
			);
			if (versions.length === 0) return yield* new SourceRejected({ code: "batch_missing", path: batch });
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
	});
	const Binding = Schema.fromJsonString(Schema.Struct({ request: Schema.String, selected: Selected }));
	const select = (selection: UndoSelection) =>
		Effect.gen(function* () {
			if (selection.batch !== undefined) return { batch: selection.batch, version: null, previous: true };
			const rows = yield* (
				selection.version !== undefined
					? sql`SELECT * FROM versions WHERE id = ${selection.version}`
					: selection.path !== undefined
						? sql`SELECT * FROM versions WHERE path = ${selection.path} ORDER BY id DESC LIMIT 1`
						: sql`SELECT * FROM versions WHERE path LIKE 'app/%' ORDER BY id DESC LIMIT 1`
			).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Version))));
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
			if (selected.batch !== null) return yield* previous(selected.batch);
			const rows = yield* sql`SELECT * FROM versions WHERE id = ${selected.version}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Version))),
			);
			const version = rows[0];
			if (!version) return yield* new SourceRejected({ code: "batch_missing", path: String(selected.version) });
			const content = selected.previous ? version.previous_content : version.content;
			const sha = selected.previous ? version.previous_sha : version.sha;
			const mode = selected.previous ? version.previous_mode : version.mode;
			if (sha !== null && content === null)
				return yield* new SourceRejected({ code: "version_unavailable", path: version.path });
			return [{ path: version.path, content, ...(mode === null ? {} : { mode }) }];
		});
	const undo = (selection: UndoSelection) =>
		sql.withTransaction(
			Effect.gen(function* () {
				if (!selection.retry) return yield* selectedWrites(yield* select(selection));
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
						}),
					),
				)({ path: selection.path ?? null, batch: selection.batch ?? null, version: selection.version ?? null });
				const rows = yield* sql`SELECT value FROM settings WHERE key = ${key}`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
				);
				const saved = rows[0] ? yield* Schema.decodeEffect(Binding)(rows[0].value) : null;
				if (saved && saved.request !== request)
					return yield* new SourceRejected({ code: "idempotency_conflict", path: "revert" });
				const selected = saved?.selected ?? (yield* select(selection));
				const writes = yield* selectedWrites(selected);
				if (!saved)
					yield* sql`INSERT INTO settings (key,value) VALUES (${key},${yield* Schema.encodeEffect(Binding)({ request, selected })})`;
				return writes;
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
			).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ path: Schema.String })))));
			return rows.length > 0 && rows.every((row) => row.path.startsWith("pages/"));
		});
	return { ready, begin, recover, history, previous, undo, targetsPages };
});
