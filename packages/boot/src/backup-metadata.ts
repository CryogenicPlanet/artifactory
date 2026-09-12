import { Effect, Schema, type Path } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** A null fence/association identifies legacy backups, whose provenance must not be guessed. */
export const BackupRecord = Schema.Struct({
	id: Schema.String,
	engine: Schema.Literals(["sqlite", "pg", "mysql"]),
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

/** Artifact names are rooted in DATA_DIR, never derived from the live store location. */
export const backupPath = (path: Path.Path, dataDirectory: string, id: string, engine: BackupRecord["engine"]) =>
	path.join(dataDirectory, "backups", `${id}.${engine === "sqlite" ? "db" : engine === "pg" ? "dump" : "sql"}`);

/** Read only catalogued paths; pre-suffix remote artifacts retain their original .db names. */
export const backupRelativePath = (
	path: Path.Path,
	directory: string,
	canonicalDirectory: string,
	artifact: Pick<BackupRecord, "id" | "engine" | "path">,
): string | null => {
	if (!/^[A-Za-z0-9_-]+$/.test(artifact.id)) return null;
	const names = [path.basename(backupPath(path, directory, artifact.id, artifact.engine))];
	if (artifact.engine !== "sqlite") names.push(`${artifact.id}.db`);
	for (const name of names) {
		const relative = path.join("backups", name);
		if (artifact.path === path.join(directory, relative) || artifact.path === path.join(canonicalDirectory, relative))
			return relative;
	}
	return null;
};
