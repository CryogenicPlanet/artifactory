import { initializeRemoteBootSchema } from "./remote-boot-schema.ts";
import { verifyBootSchemaShape } from "./boot-schema-shape.ts";
import { inspectMigrations, migrate } from "@comms/storage/migrations";
import { RecoveryRejected } from "./recovery-intents.ts";
import { hasLegacyTopicMoves } from "./legacy-topic-moves.ts";
import { publicPathsSchema } from "./public-paths.ts";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
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

export class BootIdentityUpgradePending extends Schema.TaggedError<BootIdentityUpgradePending>()(
	"BootIdentityUpgradePending",
	{},
) {
	get message() {
		return "Finish pending database recovery with the previous compatible image before upgrading board identity. Boot schema and recovery journals were preserved.";
	}
}

/** Run once before constructing boot stores; opening the adapter must use disableWAL. */
export const initializeBootSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const remote = sql.onDialectOrElse({ pg: () => "pg" as const, mysql: () => "mysql" as const, orElse: () => null });
	if (remote !== null) return yield* initializeRemoteBootSchema(sql, remote);
	const steps = [
		{
			id: 1,
			name: "generations",
			run: Effect.gen(function* () {
				yield* sql`CREATE TABLE generations (
			n INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_dir TEXT, entry_file TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('starting', 'live', 'failed', 'retired')),
			good INTEGER NOT NULL DEFAULT 0 CHECK(good IN (0, 1)), stderr TEXT NOT NULL DEFAULT '',
			error TEXT, started_at INTEGER NOT NULL, healthy_at INTEGER, retired_at INTEGER
		)`;
			}),
		},
		{
			id: 2,
			name: "settings",
			run: Effect.gen(function* () {
				yield* sql`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
				yield* sql`INSERT INTO settings (key, value) SELECT 'app_seeded', '1'
				WHERE EXISTS (SELECT 1 FROM generations WHERE snapshot_dir IS NOT NULL)`;
			}),
		},
		{
			id: 3,
			name: "edit_lock",
			run: Effect.gen(function* () {
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
			}),
		},
		{
			id: 4,
			name: "authentication",
			run: Effect.gen(function* () {
				yield* sql`CREATE TABLE IF NOT EXISTS passkeys (
		id TEXT PRIMARY KEY, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
		transports TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL
	)`;
				yield* sql`CREATE TABLE IF NOT EXISTS auth_challenges (
		id TEXT PRIMARY KEY, challenge TEXT NOT NULL, ceremony TEXT NOT NULL,
		setup_generation TEXT, expires_at INTEGER NOT NULL
	)`;
				yield* sql`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
	)`;
			}),
		},
		{
			id: 5,
			name: "source_history",
			run: sourceSchema,
		},
		{
			id: 6,
			name: "events",
			run: eventsSchema,
		},
		{
			id: 7,
			name: "enrollment",
			run: enrollmentSchema,
		},
		{
			id: 8,
			name: "refresh",
			run: refreshSchema,
		},
		{
			id: 9,
			name: "cutover",
			run: Effect.gen(function* () {
				yield* sql`CREATE TABLE child_attempts(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,receipt TEXT NOT NULL,opened INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0)`;
				yield* sql`CREATE TABLE backups(id TEXT PRIMARY KEY,path TEXT NOT NULL,reason TEXT NOT NULL,bytes INTEGER NOT NULL,taken_at INTEGER NOT NULL)`;
				yield* sql`CREATE TABLE cutover(singleton INTEGER PRIMARY KEY CHECK(singleton=1),candidate INTEGER NOT NULL,prior INTEGER,backup TEXT,lock_id TEXT NOT NULL,family TEXT NOT NULL,phase TEXT NOT NULL,candidate_epoch TEXT)`;
			}),
		},
		{
			id: 10,
			name: "session_activity",
			run: Effect.gen(function* () {
				yield* sql`ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER`;
			}),
		},
		{
			id: 11,
			name: "mint_receipts",
			run: mintSchema,
		},
		{
			id: 12,
			name: "backup_metadata",
			run: Effect.gen(function* () {
				yield* sql`ALTER TABLE child_attempts ADD COLUMN boot_id TEXT`;
				yield* backupMetadataSchema;
			}),
		},
		{
			id: 13,
			name: "recovery_journals",
			run: Effect.gen(function* () {
				yield* sql`CREATE TABLE db_restore_requests (
		proof_id TEXT PRIMARY KEY, proof_hash TEXT NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT,
		backup TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('authorized','restoring','working','rollback','restored','failed')),
		safety_backup TEXT, generation INTEGER, restored_to_seq INTEGER NOT NULL,
		event_seq INTEGER, failure TEXT, lock_id TEXT, lock_family TEXT,
		lock_owned INTEGER NOT NULL DEFAULT 0 CHECK(lock_owned IN (0,1)), candidate_epoch TEXT
	)`;
				yield* sql`CREATE UNIQUE INDEX db_restore_idempotency ON db_restore_requests (session_id,idempotency_key) WHERE idempotency_key IS NOT NULL`;
				yield* sql`CREATE UNIQUE INDEX db_restore_active ON db_restore_requests ((1))
		WHERE phase IN ('authorized','restoring','working','rollback')`;
				yield* eventRoutingSchema;
				yield* sourceTreeSchema;
			}),
		},
		{
			id: 14,
			name: "event_filters",
			run: Effect.gen(function* () {
				yield* eventFilterSchema;
				yield* publicPathsSchema(sql);
			}),
		},
		{
			id: 15,
			name: "combined_restore",
			run: Effect.gen(function* () {
				yield* sql`ALTER TABLE generations ADD COLUMN backup_id TEXT`;
				yield* sql`UPDATE generations SET backup_id=(SELECT MIN(id) FROM backups
 WHERE reason='pre-flip' AND generation=generations.n)
 WHERE (SELECT COUNT(*) FROM backups WHERE reason='pre-flip' AND generation=generations.n)=1`;
				yield* sql`ALTER TABLE db_restore_requests ADD COLUMN source_generation INTEGER`;
				yield* sql`ALTER TABLE db_restore_requests ADD COLUMN prior_generation INTEGER`;
				yield* sql`ALTER TABLE db_restore_requests ADD COLUMN source_batch TEXT`;
				yield* sql`UPDATE db_restore_requests SET prior_generation=generation`;
			}),
		},
		{
			id: 16,
			name: "reset_pin",
			run: Effect.gen(function* () {
				yield* sql`ALTER TABLE edit_lock ADD COLUMN reset_pin INTEGER NOT NULL DEFAULT 0 CHECK(reset_pin IN (0,1,2))`;
			}),
		},
		{
			id: 17,
			name: "store_identity",
			run: Effect.gen(function* () {
				yield* sql`ALTER TABLE backups ADD COLUMN legacy_store_id TEXT`;
			}),
		},
		{
			id: 18,
			name: "backup_engine",
			run: Effect.gen(function* () {
				yield* sql`ALTER TABLE backups ADD COLUMN engine TEXT NOT NULL DEFAULT 'sqlite' CHECK(engine IN ('sqlite','pg','mysql'))`;
			}),
		},
		{ id: 19, name: "sqlite_copy_ownership", run: Effect.void },
	];
	const supported = steps.length;
	const readVersion = sql`PRAGMA user_version`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ user_version: Schema.Int })))),
	);
	const mirror = (yield* readVersion)[0]?.user_version;
	if (mirror === undefined) return yield* Effect.die("Missing boot schema version");
	if (mirror > supported) return yield* new BootSchemaTooNew({ found: mirror, supported });
	const { version } = yield* inspectMigrations(sql, "boot_migrations", steps);
	// Refuse before schema or journal-mode changes so the previous image can finish recovery.
	if (version >= 9 && version < supported) {
		const cutovers = yield* sql`SELECT singleton FROM cutover WHERE phase!='accepted' LIMIT 1`;
		const restores =
			version >= 13
				? yield* sql`SELECT proof_id FROM db_restore_requests WHERE phase IN ('authorized','restoring','working','rollback') LIMIT 1`
				: [];
		if (cutovers.length > 0 || restores.length > 0) return yield* new BootIdentityUpgradePending({});
	}
	// Refusal must leave the schema readable by the previous compatible image.
	if (version < 16 && (yield* hasLegacyTopicMoves(sql)))
		return yield* new RecoveryRejected({ code: "topic_move_recovery_required" });
	// New stores can reclaim deleted pages incrementally; legacy conversion needs offline maintenance.
	if (version === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
	yield* sql`PRAGMA journal_mode = WAL`;
	yield* sql`PRAGMA synchronous = FULL`;
	yield* sql.withTransaction(
		Effect.gen(function* () {
			const currentVersion = (yield* readVersion)[0]?.user_version;
			if (currentVersion === undefined) return yield* Effect.die("Missing schema version");
			if (currentVersion > supported) return yield* new BootSchemaTooNew({ found: currentVersion, supported });
			yield* migrate(sql, "boot_migrations", steps);
			yield* verifyBootSchemaShape(sql);
		}),
	);
});

/** Preserve event JSON as the immutable batch replay identity. */
export const eventRoutingSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE events ADD COLUMN topic TEXT`;
	yield* sql`UPDATE events SET topic=json_extract(event,'$.topic')`;
});

/** Indexed projections keep the original JSON unchanged for batch replay checks. */
export const eventFilterSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE events ADD COLUMN type TEXT GENERATED ALWAYS AS (json_extract(event,'$.type')) VIRTUAL`;
	yield* sql`ALTER TABLE events ADD COLUMN actor TEXT GENERATED ALWAYS AS (json_extract(event,'$.actor')) VIRTUAL`;
	yield* sql`ALTER TABLE events ADD COLUMN instance TEXT GENERATED ALWAYS AS (json_extract(event,'$.instance')) VIRTUAL`;
	yield* sql`ALTER TABLE events ADD COLUMN level TEXT GENERATED ALWAYS AS (json_extract(event,'$.level')) VIRTUAL`;
	yield* sql`CREATE INDEX events_type_seq ON events(type,seq)`;
	yield* sql`CREATE INDEX events_actor_seq ON events(actor,seq)`;
	yield* sql`CREATE INDEX events_instance_seq ON events(instance,seq)`;
	yield* sql`CREATE INDEX events_level_seq ON events(level,seq)`;
	yield* sql`CREATE INDEX events_topic_seq ON events(topic,seq)`;
});
