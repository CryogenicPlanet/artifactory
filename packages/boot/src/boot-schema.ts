import { publicPathsSchema } from "./public-paths.ts";
import { databaseRestoreSchema } from "./database-restore-journal.ts";
import { eventFilterSchema, eventRoutingSchema } from "./event-routing-schema.ts";
import { topicMoveSchema } from "./topic-move-schema.ts";
import { topicPageMoveSchema } from "./topic-page-move-schema.ts";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { cutoverSchema } from "./cutover-schema.ts";
import { authSchema } from "./auth-schema.ts";
import { enrollmentSchema } from "./enrollment-schema.ts";
import { eventsSchema } from "./events.ts";
import { refreshSchema } from "./refresh-schema.ts";
import { backupMetadataSchema } from "./backup-metadata.ts";
import { mintSchema } from "./token-mint-schema.ts";
import { sourceSchema, sourceTreeSchema } from "./source-schema.ts";

export class BootSchemaTooNew extends Schema.TaggedError<BootSchemaTooNew>()("BootSchemaTooNew", {
	found: Schema.Int,
	supported: Schema.Int,
}) {
	get message() {
		return `Boot schema ${this.found} is newer than supported schema ${this.supported}`;
	}
}

/** Run once before constructing boot stores; opening the adapter must use disableWAL. */
export const initializeBootSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const versions = yield* sql`PRAGMA user_version`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ user_version: Schema.Int })))),
	);
	const version = versions[0]?.user_version;
	if (version === undefined) return yield* Effect.die("Missing boot schema version");
	if (version > 16) return yield* new BootSchemaTooNew({ found: version, supported: 16 });
	// New stores can reclaim deleted pages incrementally; legacy conversion needs offline maintenance.
	if (version === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
	yield* sql`PRAGMA journal_mode = WAL`;
	yield* sql`PRAGMA synchronous = FULL`;
	if (version === 16) return;
	yield* sql.withTransaction(
		Effect.gen(function* () {
			if (version === 0)
				yield* sql`CREATE TABLE generations (
			n INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_dir TEXT, entry_file TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('starting', 'live', 'failed', 'retired')),
			good INTEGER NOT NULL DEFAULT 0 CHECK(good IN (0, 1)), stderr TEXT NOT NULL DEFAULT '',
			error TEXT, started_at INTEGER NOT NULL, healthy_at INTEGER, retired_at INTEGER
		)`;
			if (version < 2) {
				yield* sql`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
				yield* sql`INSERT INTO settings (key, value) SELECT 'app_seeded', '1'
				WHERE EXISTS (SELECT 1 FROM generations WHERE snapshot_dir IS NOT NULL)`;
			}
			if (version < 3) {
				yield* sql`CREATE TABLE edit_lock (
			singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL UNIQUE,
			holder_family TEXT NOT NULL, agent TEXT NOT NULL, since INTEGER NOT NULL,
			expires INTEGER NOT NULL, ttl_seconds INTEGER NOT NULL CHECK(ttl_seconds BETWEEN 1 AND 3600),
			note TEXT NOT NULL, cutover_in_flight INTEGER NOT NULL DEFAULT 0 CHECK(cutover_in_flight IN (0, 1)),
			pending_release TEXT CHECK(pending_release IN ('broken', 'revoked'))
		)`;
				yield* sql`CREATE TABLE staging (
			lock_id TEXT NOT NULL, path TEXT NOT NULL, content BLOB, sha TEXT, at INTEGER NOT NULL,
			PRIMARY KEY(lock_id, path), CHECK((content IS NULL) = (sha IS NULL))
		)`;
			}
			if (version < 4) yield* authSchema;
			if (version < 5) yield* sourceSchema;
			if (version < 6) yield* eventsSchema;
			if (version < 7) yield* enrollmentSchema;
			if (version < 8) yield* refreshSchema;
			if (version < 9) yield* cutoverSchema;
			if (version < 10) yield* sql`ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER`;
			if (version < 11) yield* mintSchema;
			if (version < 12) {
				yield* sql`ALTER TABLE child_attempts ADD COLUMN boot_id TEXT`;
				yield* backupMetadataSchema;
			}
			if (version < 13) {
				yield* databaseRestoreSchema;
				yield* eventRoutingSchema;
				yield* topicMoveSchema;
				yield* topicPageMoveSchema;
				yield* sourceTreeSchema;
			}
			if (version < 14) {
				yield* eventFilterSchema;
				yield* publicPathsSchema(sql);
			}
			if (version < 15) {
				yield* sql`ALTER TABLE generations ADD COLUMN backup_id TEXT`;
				yield* sql`UPDATE generations SET backup_id=(SELECT MIN(id) FROM backups
 WHERE reason='pre-flip' AND generation=generations.n)
 WHERE (SELECT COUNT(*) FROM backups WHERE reason='pre-flip' AND generation=generations.n)=1`;
				yield* sql`ALTER TABLE db_restore_requests ADD COLUMN source_generation INTEGER`;
				yield* sql`ALTER TABLE db_restore_requests ADD COLUMN prior_generation INTEGER`;
				yield* sql`ALTER TABLE db_restore_requests ADD COLUMN source_batch TEXT`;
				yield* sql`UPDATE db_restore_requests SET prior_generation=generation`;
			}
			if (version < 16)
				yield* sql`ALTER TABLE edit_lock ADD COLUMN reset_pin INTEGER NOT NULL DEFAULT 0 CHECK(reset_pin IN (0,1,2))`;
			yield* sql`PRAGMA user_version = 16`;
		}),
	);
});
