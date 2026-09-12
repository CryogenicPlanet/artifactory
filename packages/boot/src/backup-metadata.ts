import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** A null fence/association identifies legacy backups, whose provenance must not be guessed. */
export const BackupRecord = Schema.Struct({
	id: Schema.String,
	path: Schema.String,
	reason: Schema.String,
	bytes: Schema.Int,
	taken_at: Schema.Int,
	published_through: Schema.NullOr(Schema.Int),
	generation: Schema.NullOr(Schema.Int),
	legacy_store_id: Schema.NullOr(Schema.String),
});
export type BackupRecord = typeof BackupRecord.Type;
export const backupMetadataSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE backups ADD COLUMN published_through INTEGER`;
	yield* sql`ALTER TABLE backups ADD COLUMN generation INTEGER`;
});
