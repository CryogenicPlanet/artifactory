import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export class SourceRejected extends Schema.TaggedError<SourceRejected>()("SourceRejected", {
	code: Schema.Literals([
		"invalid_path",
		"path_conflict",
		"publication_pending",
		"external_conflict",
		"stale_base",
		"idempotency_conflict",
		"invalid_text",
		"version_unavailable",
		"generation_unavailable",
		"batch_missing",
		"proposal_missing",
	]),
	path: Schema.String,
}) {
	get message() {
		return `Source operation rejected: ${this.code}: ${this.path}`;
	}
}
export const Image = Schema.Struct({
	directory: Schema.optional(Schema.Literal(true)),
	content: Schema.NullOr(Schema.Uint8Array),
	sha: Schema.NullOr(Schema.String),
	mode: Schema.NullOr(Schema.Int),
});
export type Image = typeof Image.Type;
export const Change = Schema.Struct({ path: Schema.String, before: Image, desired: Image });
export type Change = typeof Change.Type;
export interface Write {
	readonly path: string;
	readonly content: Uint8Array | null;
	readonly mode?: number;
	readonly baseVersion?: string | null;
}
export const Batch = Schema.Struct({
	id: Schema.String,
	lock_id: Schema.NullOr(Schema.String),
	agent: Schema.String,
	at: Schema.Int,
	state: Schema.Literals(["publishing", "published"]),
});
export const Version = Schema.Struct({
	directory: Schema.Literals([0, 1]),
	previous_directory: Schema.Literals([0, 1]),
	id: Schema.Int,
	batch: Schema.String,
	path: Schema.String,
	agent: Schema.String,
	at: Schema.Int,
	sha: Schema.NullOr(Schema.String),
	mode: Schema.NullOr(Schema.Int),
	content: Schema.NullOr(Schema.Uint8Array),
	previous_sha: Schema.NullOr(Schema.String),
	previous_mode: Schema.NullOr(Schema.Int),
	previous_content: Schema.NullOr(Schema.Uint8Array),
	versioned: Schema.Literals([0, 1]),
	reason: Schema.NullOr(Schema.Literal("size_limit")),
});
export const sourceSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE staging ADD COLUMN mode INTEGER`;
	yield* sql`CREATE TABLE source_batches (id TEXT PRIMARY KEY, lock_id TEXT, agent TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('publishing','published')))`;
	yield* sql`CREATE UNIQUE INDEX source_single_publication ON source_batches(state) WHERE state = 'publishing'`;
	yield* sql`CREATE TABLE source_changes (batch TEXT NOT NULL REFERENCES source_batches(id), path TEXT NOT NULL, before BLOB, before_sha TEXT, before_mode INTEGER, desired BLOB, desired_sha TEXT, desired_mode INTEGER, PRIMARY KEY(batch,path), CHECK((before IS NULL) = (before_sha IS NULL)), CHECK((before IS NULL) = (before_mode IS NULL)), CHECK((desired IS NULL) = (desired_sha IS NULL)), CHECK((desired IS NULL) = (desired_mode IS NULL)))`;
	yield* sql`CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, batch TEXT NOT NULL REFERENCES source_batches(id), path TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL, content BLOB, sha TEXT, mode INTEGER, previous_content BLOB, previous_sha TEXT, previous_mode INTEGER, versioned INTEGER NOT NULL CHECK(versioned IN (0,1)), reason TEXT CHECK(reason = 'size_limit'), UNIQUE(batch,path))`;
	yield* sql`CREATE INDEX source_versions_path ON versions(path,id)`;
});

/** Directory identity is separate from absent file images; existing file history remains compatible. */
export const sourceTreeSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	for (const table of ["source_changes", "versions"] as const) {
		const before = table === "versions" ? "previous_directory" : "before_directory";
		const desired = table === "versions" ? "directory" : "desired_directory";
		yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${before} INTEGER NOT NULL DEFAULT 0 CHECK(${before} IN (0,1))`);
		yield* sql.unsafe(
			`ALTER TABLE ${table} ADD COLUMN ${desired} INTEGER NOT NULL DEFAULT 0 CHECK(${desired} IN (0,1))`,
		);
	}
});
