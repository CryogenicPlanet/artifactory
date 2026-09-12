import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Scope = Schema.Literals(["read", "write", "fs"]);
export const EnrollmentDecision = Schema.Struct({
	id: Schema.String,
	decision: Schema.Literals(["approve", "deny"]),
	scopes: Schema.Array(Scope),
	long_lived: Schema.Boolean,
});
export type EnrollmentDecision = typeof EnrollmentDecision.Type;
export const canonicalDecision = (input: EnrollmentDecision) =>
	JSON.stringify({
		id: input.id,
		decision: input.decision,
		scopes: ["read", "write", "fs"].filter((scope) => input.scopes.some((value) => value === scope)),
		long_lived: input.long_lived,
	});
export const validDecision = (input: EnrollmentDecision) =>
	/^e_[A-Za-z0-9_-]{43}$/.test(input.id) &&
	new Set(input.scopes).size === input.scopes.length &&
	(input.decision === "approve" ? input.scopes.length > 0 : input.scopes.length === 0 && !input.long_lived);

export const enrollmentSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE enrollments (
 id TEXT PRIMARY KEY, device_secret_hash TEXT NOT NULL, user_code TEXT NOT NULL,
 agent_name TEXT NOT NULL, kind TEXT NOT NULL, host TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','collected')),
 family TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 collected_at INTEGER, scopes TEXT, access_seconds INTEGER, refresh_seconds INTEGER
 )`;
	yield* sql`CREATE TABLE tokens (
 id TEXT PRIMARY KEY, pair_id TEXT NOT NULL, family TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
 hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER, rotated_to TEXT, rotated_at INTEGER
 )`;
	yield* sql`CREATE INDEX tokens_family ON tokens(family)`;
});
