import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Request receipts also hold the one active restore's authoritative-store selection. */
export const databaseRestoreSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
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
});
