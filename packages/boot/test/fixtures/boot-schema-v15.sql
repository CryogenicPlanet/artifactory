-- Frozen pre-cut schema: initialized from 1bcf41f (boot schema 16), then removed reset_pin and set user_version=15.
-- Contains no identity/backup-engine columns or migration ledger from later stack layers.
BEGIN TRANSACTION;
CREATE TABLE auth_challenges (
		id TEXT PRIMARY KEY, challenge TEXT NOT NULL, ceremony TEXT NOT NULL,
		setup_generation TEXT, expires_at INTEGER NOT NULL
	);
CREATE TABLE backups(id TEXT PRIMARY KEY,path TEXT NOT NULL,reason TEXT NOT NULL,bytes INTEGER NOT NULL,taken_at INTEGER NOT NULL, published_through INTEGER, generation INTEGER);
CREATE TABLE child_attempts(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,receipt TEXT NOT NULL,opened INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0, boot_id TEXT);
CREATE TABLE cutover(singleton INTEGER PRIMARY KEY CHECK(singleton=1),candidate INTEGER NOT NULL,prior INTEGER,backup TEXT,lock_id TEXT NOT NULL,family TEXT NOT NULL,phase TEXT NOT NULL,candidate_epoch TEXT);
CREATE TABLE db_restore_requests (
		proof_id TEXT PRIMARY KEY, proof_hash TEXT NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT,
		backup TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('authorized','restoring','working','rollback','restored','failed')),
		safety_backup TEXT, generation INTEGER, restored_to_seq INTEGER NOT NULL,
		event_seq INTEGER, failure TEXT, lock_id TEXT, lock_family TEXT,
		lock_owned INTEGER NOT NULL DEFAULT 0 CHECK(lock_owned IN (0,1)), candidate_epoch TEXT
	, source_generation INTEGER, prior_generation INTEGER, source_batch TEXT);
CREATE TABLE edit_lock (
			singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL UNIQUE,
			holder_family TEXT NOT NULL, agent TEXT NOT NULL, since INTEGER NOT NULL,
			expires INTEGER NOT NULL, ttl_seconds INTEGER NOT NULL CHECK(ttl_seconds BETWEEN 1 AND 3600),
			note TEXT NOT NULL, cutover_in_flight INTEGER NOT NULL DEFAULT 0 CHECK(cutover_in_flight IN (0, 1)),
			pending_release TEXT CHECK(pending_release IN ('broken', 'revoked'))
		);
CREATE TABLE enrollments (
 id TEXT PRIMARY KEY, device_secret_hash TEXT NOT NULL, user_code TEXT NOT NULL,
 agent_name TEXT NOT NULL, kind TEXT NOT NULL, host TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','collected')),
 family TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 collected_at INTEGER, scopes TEXT, access_seconds INTEGER, refresh_seconds INTEGER
 );
CREATE TABLE event_batches (id TEXT PRIMARY KEY, attempt TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, state TEXT NOT NULL);
CREATE TABLE events (seq INTEGER PRIMARY KEY, transaction_id TEXT, event TEXT NOT NULL, topic TEXT, type TEXT GENERATED ALWAYS AS (json_extract(event,'$.type')) VIRTUAL, actor TEXT GENERATED ALWAYS AS (json_extract(event,'$.actor')) VIRTUAL, instance TEXT GENERATED ALWAYS AS (json_extract(event,'$.instance')) VIRTUAL, level TEXT GENERATED ALWAYS AS (json_extract(event,'$.level')) VIRTUAL);
CREATE TABLE generations (
			n INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_dir TEXT, entry_file TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('starting', 'live', 'failed', 'retired')),
			good INTEGER NOT NULL DEFAULT 0 CHECK(good IN (0, 1)), stderr TEXT NOT NULL DEFAULT '',
			error TEXT, started_at INTEGER NOT NULL, healthy_at INTEGER, retired_at INTEGER
		, backup_id TEXT);
CREATE TABLE mint_receipts (
 session_id TEXT NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, proof_hash TEXT NOT NULL,
 family TEXT NOT NULL, successor_access_id TEXT NOT NULL, successor_refresh_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 salt TEXT NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL,
 PRIMARY KEY(session_id,key_hash), UNIQUE(session_id,proof_hash)
 );
CREATE TABLE passkeys (
		id TEXT PRIMARY KEY, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
		transports TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL
	);
CREATE TABLE public_paths (path TEXT PRIMARY KEY NOT NULL);
CREATE TABLE refresh_idempotency (
 family TEXT NOT NULL, key_hash TEXT NOT NULL, predecessor TEXT NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(family,key_hash)
 );
CREATE TABLE refresh_receipts (
 predecessor TEXT PRIMARY KEY, family TEXT NOT NULL, successor_access_id TEXT NOT NULL,
 successor_refresh_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 salt TEXT NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL
 );
CREATE TABLE seq (singleton INTEGER PRIMARY KEY CHECK(singleton=1), next INTEGER NOT NULL,
 published_through INTEGER NOT NULL, pending_id TEXT, pending_attempt TEXT, pending_from INTEGER, pending_to INTEGER);
INSERT INTO "seq" VALUES(1,1,0,NULL,NULL,NULL,NULL);
CREATE TABLE sessions (
		id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
	, last_seen_at INTEGER);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE source_batches (id TEXT PRIMARY KEY, lock_id TEXT, agent TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('publishing','published')));
CREATE TABLE source_changes (batch TEXT NOT NULL REFERENCES source_batches(id), path TEXT NOT NULL, before BLOB, before_sha TEXT, before_mode INTEGER, desired BLOB, desired_sha TEXT, desired_mode INTEGER, before_directory INTEGER NOT NULL DEFAULT 0 CHECK(before_directory IN (0,1)), desired_directory INTEGER NOT NULL DEFAULT 0 CHECK(desired_directory IN (0,1)), PRIMARY KEY(batch,path), CHECK((before IS NULL) = (before_sha IS NULL)), CHECK((before IS NULL) = (before_mode IS NULL)), CHECK((desired IS NULL) = (desired_sha IS NULL)), CHECK((desired IS NULL) = (desired_mode IS NULL)));
CREATE TABLE staging (
			lock_id TEXT NOT NULL, path TEXT NOT NULL, content BLOB, sha TEXT, at INTEGER NOT NULL, mode INTEGER,
			PRIMARY KEY(lock_id, path), CHECK((content IS NULL) = (sha IS NULL))
		);
CREATE TABLE tokens (
 id TEXT PRIMARY KEY, pair_id TEXT NOT NULL, family TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
 hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER, rotated_to TEXT, rotated_at INTEGER
 );
CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, batch TEXT NOT NULL REFERENCES source_batches(id), path TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL, content BLOB, sha TEXT, mode INTEGER, previous_content BLOB, previous_sha TEXT, previous_mode INTEGER, versioned INTEGER NOT NULL CHECK(versioned IN (0,1)), reason TEXT CHECK(reason = 'size_limit'), previous_directory INTEGER NOT NULL DEFAULT 0 CHECK(previous_directory IN (0,1)), directory INTEGER NOT NULL DEFAULT 0 CHECK(directory IN (0,1)), UNIQUE(batch,path));
CREATE UNIQUE INDEX source_single_publication ON source_batches(state) WHERE state = 'publishing';
CREATE INDEX source_versions_path ON versions(path,id);
CREATE INDEX tokens_family ON tokens(family);
CREATE UNIQUE INDEX db_restore_idempotency ON db_restore_requests (session_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX db_restore_active ON db_restore_requests ((1))
		WHERE phase IN ('authorized','restoring','working','rollback');
CREATE INDEX events_type_seq ON events(type,seq);
CREATE INDEX events_actor_seq ON events(actor,seq);
CREATE INDEX events_instance_seq ON events(instance,seq);
CREATE INDEX events_level_seq ON events(level,seq);
CREATE INDEX events_topic_seq ON events(topic,seq);
DELETE FROM "sqlite_sequence";
COMMIT;
PRAGMA user_version=15;
