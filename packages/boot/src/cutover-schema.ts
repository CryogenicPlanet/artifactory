import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const cutoverSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE child_attempts(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,receipt TEXT NOT NULL,opened INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0)`;
	yield* sql`CREATE TABLE backups(id TEXT PRIMARY KEY,path TEXT NOT NULL,reason TEXT NOT NULL,bytes INTEGER NOT NULL,taken_at INTEGER NOT NULL)`;
	yield* sql`CREATE TABLE cutover(singleton INTEGER PRIMARY KEY CHECK(singleton=1),candidate INTEGER NOT NULL,prior INTEGER,backup TEXT,lock_id TEXT NOT NULL,family TEXT NOT NULL,phase TEXT NOT NULL,candidate_epoch TEXT)`;
});
