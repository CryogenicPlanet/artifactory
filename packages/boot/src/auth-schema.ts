import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Included in the boot migration; it never opens a second database. */
export const authSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
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
});
