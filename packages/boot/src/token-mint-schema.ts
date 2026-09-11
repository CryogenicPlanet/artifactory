import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Scope } from "./enrollment-schema.ts";

export const MintToken = Schema.Struct({
	agent: Schema.String,
	label: Schema.String,
	scopes: Schema.Array(Scope),
	long_lived: Schema.Boolean,
});
export type MintToken = typeof MintToken.Type;
export const MintBinding = Schema.Struct({ ...MintToken.fields, idempotency_key: Schema.optionalKey(Schema.String) });
export type MintBinding = typeof MintBinding.Type;
export const validMint = (input: MintBinding) =>
	/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.agent) &&
	!["rahul", "boot"].includes(input.agent) &&
	/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(input.label) &&
	input.scopes.length > 0 &&
	new Set(input.scopes).size === input.scopes.length &&
	(input.idempotency_key === undefined || /^[\x20-\x7e]{1,128}$/.test(input.idempotency_key));
export const canonicalMint = (input: MintBinding) =>
	JSON.stringify({
		agent: input.agent,
		label: input.label,
		scopes: ["read", "write", "fs"].filter((scope) => input.scopes.some((value) => value === scope)),
		long_lived: input.long_lived,
		idempotency_key: input.idempotency_key ?? null,
	});
export const MintReceipt = Schema.Struct({
	session_id: Schema.String,
	key_hash: Schema.String,
	request_hash: Schema.String,
	proof_hash: Schema.String,
	family: Schema.String,
	successor_access_id: Schema.String,
	successor_refresh_id: Schema.String,
	expires_at: Schema.Int,
	salt: Schema.String,
	nonce: Schema.String,
	ciphertext: Schema.String,
	tag: Schema.String,
});
export type MintReceipt = typeof MintReceipt.Type;
export const mintSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE mint_receipts (
 session_id TEXT NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, proof_hash TEXT NOT NULL,
 family TEXT NOT NULL, successor_access_id TEXT NOT NULL, successor_refresh_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 salt TEXT NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL,
 PRIMARY KEY(session_id,key_hash), UNIQUE(session_id,proof_hash)
 )`;
});
