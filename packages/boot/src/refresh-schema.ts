import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Scope } from "./enrollment-schema.ts";

/** Canonical persisted credential row; callers select only fields their operation needs. */
export const Token = Schema.Struct({
	id: Schema.String,
	pair_id: Schema.String,
	family: Schema.String,
	agent: Schema.String,
	kind: Schema.String,
	hash: Schema.String,
	label: Schema.String,
	scopes: Schema.fromJsonString(Schema.Array(Scope)),
	expires_at: Schema.Int,
	created_at: Schema.Int,
	revoked_at: Schema.NullOr(Schema.Int),
});

export const RevokeFamily = Schema.Struct({ family: Schema.String });
export type RevokeFamily = typeof RevokeFamily.Type;
export const validFamily = (family: string) => /^f_[A-Za-z0-9_-]{43}$/.test(family);
export const canonicalRevocation = (params: RevokeFamily) => JSON.stringify({ family: params.family });
export const TokenPair = Schema.Struct({
	access: Schema.String,
	refresh: Schema.String,
	expires_at: Schema.Int,
	refresh_expires_at: Schema.Int,
	agent: Schema.String,
	label: Schema.String,
	scopes: Schema.Array(Scope),
	family: Schema.String,
});
export type TokenPair = typeof TokenPair.Type;
export const Receipt = Schema.Struct({
	predecessor: Schema.String,
	family: Schema.String,
	successor_access_id: Schema.String,
	successor_refresh_id: Schema.String,
	expires_at: Schema.Int,
	salt: Schema.String,
	nonce: Schema.String,
	ciphertext: Schema.String,
	tag: Schema.String,
});
export type Receipt = typeof Receipt.Type;

/** V8 adds only short-lived encrypted replay material; existing token rows remain unchanged. */
export const refreshSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE refresh_receipts (
 predecessor TEXT PRIMARY KEY, family TEXT NOT NULL, successor_access_id TEXT NOT NULL,
 successor_refresh_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 salt TEXT NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL
 )`;
	yield* sql`CREATE TABLE refresh_idempotency (
 family TEXT NOT NULL, key_hash TEXT NOT NULL, predecessor TEXT NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(family,key_hash)
 )`;
});

/** Lazy expiry runs in the caller's token transaction; token use evidence is deliberately retained. */
export const expireRefreshReceipts = (sql: SqlClient.SqlClient, now: number) =>
	Effect.gen(function* () {
		yield* sql`DELETE FROM refresh_receipts WHERE expires_at<=${now}`;
		yield* sql`DELETE FROM refresh_idempotency WHERE expires_at<=${now}`;
	});
