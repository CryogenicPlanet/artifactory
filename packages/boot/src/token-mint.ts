import { authSecrets, refuse } from "./auth-primitives.ts";
import { Clock, Crypto, Effect, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { AssertionProof } from "./enrollment.ts";
import { Scope } from "./enrollment-schema.ts";
import { Events } from "./events.ts";
import { openMintReceipt, ReceiptError, sealMintReceipt } from "./refresh-receipt.ts";
import type { TokenPair } from "./refresh-schema.ts";
import { canonicalMint, MintReceipt, validMint, type MintBinding } from "./token-mint-schema.ts";

const Session = Schema.Struct({ id: Schema.String, expires_at: Schema.Int });
const Token = Schema.Struct({
	id: Schema.String,
	pair_id: Schema.String,
	family: Schema.String,
	agent: Schema.String,
	kind: Schema.String,
	label: Schema.String,
	scopes: Schema.fromJsonString(Schema.Array(Scope)),
	hash: Schema.String,
	expires_at: Schema.Int,
	created_at: Schema.Int,
	revoked_at: Schema.NullOr(Schema.Int),
});
const canonicalProof = (proof: AssertionProof) =>
	JSON.stringify([
		proof.id,
		proof.response.id,
		proof.response.rawId,
		proof.response.type,
		proof.response.response.clientDataJSON,
		proof.response.response.authenticatorData,
		proof.response.response.signature,
		proof.response.response.userHandle ?? null,
	]);

/** One signed transaction owns issuance and a session-encrypted exact response receipt. */
export const makeTokenMint = <E, R>(
	verify: (params: MintBinding, proof: AssertionProof) => Effect.Effect<void, E, R>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const events = yield* Events;
		const { hash, random } = authSecrets(crypto);
		const mintTokens = (params: MintBinding, proof: AssertionProof, sessionId: string, sessionSecret: string) =>
			mutex.withPermit(
				sql.withTransaction(
					Effect.gen(function* () {
						if (!validMint(params)) return yield* refuse("invalid_request");
						const sessionHash = yield* hash(sessionSecret);
						const liveSession = Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							const session =
								(yield* sql`SELECT id,expires_at FROM sessions WHERE id=${sessionId} AND hash=${sessionHash} AND expires_at>${now}`.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Session))),
								))[0];
							if (!session) return yield* refuse("session_invalid");
							return session;
						});
						const session = yield* liveSession;
						const now = yield* Clock.currentTimeMillis;
						yield* sql`DELETE FROM mint_receipts WHERE expires_at<=${now}`;
						const requestHash = yield* hash(canonicalMint(params));
						const proofHash = yield* hash(canonicalProof(proof));
						const keyHash = yield* hash(
							params.idempotency_key === undefined ? `proof:${proof.id}` : `key:${params.idempotency_key}`,
						);
						const receipt =
							(yield* sql`SELECT * FROM mint_receipts WHERE session_id=${sessionId} AND key_hash=${keyHash}`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MintReceipt))),
							))[0];
						if (receipt) {
							if (receipt.request_hash !== requestHash) return yield* refuse("idempotency_conflict");
							if (receipt.proof_hash !== proofHash) return yield* refuse("assertion_invalid");
							if (receipt.expires_at !== session.expires_at) return yield* new ReceiptError({});
							const pair = yield* openMintReceipt(sessionSecret, receipt);
							const rows =
								yield* sql`SELECT * FROM tokens WHERE family=${receipt.family} AND (id=${receipt.successor_access_id} OR id=${receipt.successor_refresh_id})`.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Token))),
								);
							if (rows.some((row) => row.revoked_at !== null)) return yield* refuse("family_revoked");
							const access = rows.find((row) => row.id === receipt.successor_access_id && row.kind === "access");
							const refresh = rows.find((row) => row.id === receipt.successor_refresh_id && row.kind === "refresh");
							const accessHash = yield* hash(pair.access),
								refreshHash = yield* hash(pair.refresh);
							if (
								!access ||
								!refresh ||
								rows.length !== 2 ||
								access.pair_id !== refresh.pair_id ||
								access.created_at !== refresh.created_at ||
								access.hash !== accessHash ||
								refresh.hash !== refreshHash ||
								access.expires_at !== pair.expires_at ||
								refresh.expires_at !== pair.refresh_expires_at ||
								pair.family !== receipt.family ||
								pair.agent !== params.agent ||
								pair.label !== params.label ||
								rows.some(
									(row) =>
										row.agent !== pair.agent ||
										row.label !== pair.label ||
										row.scopes.length !== pair.scopes.length ||
										row.scopes.some((scope, index) => scope !== pair.scopes[index]),
								) ||
								pair.scopes.length !== params.scopes.length ||
								pair.scopes.some((scope) => !params.scopes.includes(scope))
							)
								return yield* new ReceiptError({});
							yield* liveSession;
							return pair;
						}
						yield* verify(params, proof);
						yield* liveSession;
						const issuedAt = yield* Clock.currentTimeMillis;
						const scopes = params.scopes.toSorted(
							(left, right) => ["read", "write", "fs"].indexOf(left) - ["read", "write", "fs"].indexOf(right),
						);
						const family = `f_${yield* random}`,
							pairId = `p_${yield* random}`;
						const accessId = `t_${yield* random}`,
							refreshId = `t_${yield* random}`;
						const pair: TokenPair = {
							access: yield* random,
							refresh: yield* random,
							agent: params.agent,
							label: params.label,
							family,
							scopes,
							expires_at: issuedAt + (params.long_lived ? 604800 : 86400) * 1000,
							refresh_expires_at: issuedAt + (params.long_lived ? 7776000 : 2592000) * 1000,
						};
						const encodedScopes = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Scope)))(scopes);
						for (const [id, kind, value, expires] of [
							[accessId, "access", pair.access, pair.expires_at],
							[refreshId, "refresh", pair.refresh, pair.refresh_expires_at],
						] as const) {
							const tokenHash = yield* hash(value);
							yield* sql`INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at) VALUES(${id},${pairId},${family},${params.agent},${kind},${tokenHash},${params.label},${encodedScopes},${expires},${issuedAt})`;
						}
						const sealed = yield* sealMintReceipt(
							sessionSecret,
							{
								session_id: sessionId,
								key_hash: keyHash,
								request_hash: requestHash,
								proof_hash: proofHash,
								family,
								successor_access_id: accessId,
								successor_refresh_id: refreshId,
								expires_at: session.expires_at,
							},
							pair,
						);
						yield* sql`INSERT INTO mint_receipts ${sql.insert(sealed)}`;
						yield* events.writeBoot({
							at: issuedAt,
							type: "token.minted",
							level: "info",
							actor: "rahul",
							instance: family,
							generation: 0,
							request_id: null,
							topic: null,
							message_id: null,
							payload: { family, agent: params.agent, label: params.label, scopes },
						});
						yield* liveSession;
						return pair;
					}),
				),
			);
		return { mintTokens };
	});
