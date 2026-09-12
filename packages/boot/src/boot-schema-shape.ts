import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

/** Validate boot's required columns before committing migration receipts.
 * These read-only probes do not verify indexes, constraints or existing row values. */
export const verifyBootSchemaShape = (sql: SqlClient) =>
	Effect.gen(function* () {
		yield* sql`SELECT shape."id",shape."challenge",shape."ceremony",shape."setup_generation",shape."expires_at" FROM "auth_challenges" AS shape LIMIT 0`;
		yield* sql`SELECT shape."id",shape."path",shape."reason",shape."bytes",shape."taken_at",shape."published_through",shape."generation",shape."legacy_store_id",shape."engine" FROM "backups" AS shape LIMIT 0`;
		yield* sql`SELECT shape."id",shape."generation",shape."receipt",shape."opened",shape."closed",shape."boot_id" FROM "child_attempts" AS shape LIMIT 0`;
		yield* sql`SELECT shape."singleton",shape."candidate",shape."prior",shape."backup",shape."lock_id",shape."family",shape."phase",shape."candidate_epoch" FROM "cutover" AS shape LIMIT 0`;
		yield* sql`SELECT shape."proof_id",shape."proof_hash",shape."session_id",shape."idempotency_key",shape."backup",shape."phase",shape."safety_backup",shape."generation",shape."restored_to_seq",shape."event_seq",shape."failure",shape."lock_id",shape."lock_family",shape."lock_owned",shape."candidate_epoch",shape."source_generation",shape."prior_generation",shape."source_batch" FROM "db_restore_requests" AS shape LIMIT 0`;
		yield* sql`SELECT shape."singleton",shape."id",shape."holder_family",shape."agent",shape."since",shape."expires",shape."ttl_seconds",shape."note",shape."cutover_in_flight",shape."pending_release",shape."reset_pin" FROM "edit_lock" AS shape LIMIT 0`;
		yield* sql`SELECT shape."id",shape."device_secret_hash",shape."user_code",shape."agent_name",shape."kind",shape."host",shape."status",shape."family",shape."created_at",shape."expires_at",shape."collected_at",shape."scopes",shape."access_seconds",shape."refresh_seconds" FROM "enrollments" AS shape LIMIT 0`;
		yield* sql`SELECT shape."id",shape."attempt",shape."from_seq",shape."to_seq",shape."state" FROM "event_batches" AS shape LIMIT 0`;
		yield* sql`SELECT shape."seq",shape."transaction_id",shape."event",shape."topic",shape."type",shape."actor",shape."instance",shape."level" FROM "events" AS shape LIMIT 0`;
		yield* sql`SELECT shape."n",shape."snapshot_dir",shape."entry_file",shape."status",shape."good",shape."stderr",shape."error",shape."started_at",shape."healthy_at",shape."retired_at",shape."backup_id" FROM "generations" AS shape LIMIT 0`;
		yield* sql`SELECT shape."session_id",shape."key_hash",shape."request_hash",shape."proof_hash",shape."family",shape."successor_access_id",shape."successor_refresh_id",shape."expires_at",shape."salt",shape."nonce",shape."ciphertext",shape."tag" FROM "mint_receipts" AS shape LIMIT 0`;
		yield* sql`SELECT shape."id",shape."public_key",shape."counter",shape."transports",shape."label",shape."created_at" FROM "passkeys" AS shape LIMIT 0`;
		yield* sql`SELECT shape."path" FROM "public_paths" AS shape LIMIT 0`;
		yield* sql`SELECT shape."family",shape."key_hash",shape."predecessor",shape."expires_at" FROM "refresh_idempotency" AS shape LIMIT 0`;
		yield* sql`SELECT shape."predecessor",shape."family",shape."successor_access_id",shape."successor_refresh_id",shape."expires_at",shape."salt",shape."nonce",shape."ciphertext",shape."tag" FROM "refresh_receipts" AS shape LIMIT 0`;
		yield* sql`SELECT shape."singleton",shape."next",shape."published_through",shape."pending_id",shape."pending_attempt",shape."pending_from",shape."pending_to" FROM "seq" AS shape LIMIT 0`;
		yield* sql`SELECT shape."id",shape."hash",shape."created_at",shape."expires_at",shape."last_seen_at" FROM "sessions" AS shape LIMIT 0`;
		yield* sql`SELECT shape."key",shape."value" FROM "settings" AS shape LIMIT 0`;
		yield* sql`SELECT shape."id",shape."lock_id",shape."agent",shape."at",shape."state" FROM "source_batches" AS shape LIMIT 0`;
		yield* sql`SELECT shape."batch",shape."path",shape."before",shape."before_sha",shape."before_mode",shape."desired",shape."desired_sha",shape."desired_mode",shape."before_directory",shape."desired_directory" FROM "source_changes" AS shape LIMIT 0`;
		yield* sql`SELECT shape."lock_id",shape."path",shape."content",shape."sha",shape."at",shape."mode" FROM "staging" AS shape LIMIT 0`;
		yield* sql`SELECT shape."id",shape."pair_id",shape."family",shape."agent",shape."kind",shape."hash",shape."label",shape."scopes",shape."expires_at",shape."created_at",shape."last_used_at",shape."revoked_at",shape."rotated_to",shape."rotated_at" FROM "tokens" AS shape LIMIT 0`;
		yield* sql`SELECT shape."id",shape."batch",shape."path",shape."agent",shape."at",shape."content",shape."sha",shape."mode",shape."previous_content",shape."previous_sha",shape."previous_mode",shape."versioned",shape."reason",shape."previous_directory",shape."directory" FROM "versions" AS shape LIMIT 0`;
	});
