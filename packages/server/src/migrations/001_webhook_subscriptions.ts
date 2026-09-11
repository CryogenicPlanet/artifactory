import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Optional reference extension data; delivery checkpoints never allocate public sequences. */
export default Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE webhook_subscriptions (
 id TEXT PRIMARY KEY, instance TEXT NOT NULL, agent TEXT NOT NULL, human INTEGER NOT NULL,
 input TEXT NOT NULL, idempotency_key TEXT, created_at INTEGER NOT NULL,
 start_seq INTEGER NOT NULL, created_seq INTEGER NOT NULL, deleted_seq INTEGER,
 cursor INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT,
 UNIQUE(instance,idempotency_key))`;
});
