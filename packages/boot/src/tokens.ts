import { decodeRows } from "./decode-rows.ts";
import { authSecrets, refuse, committed, captureRefusal } from "./auth-primitives.ts";
import { Clock, Crypto, Effect, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError } from "./auth.ts";
import { EditLock } from "./edit-lock.ts";
import type { AssertionProof } from "./enrollment.ts";
import { Scope } from "./enrollment-schema.ts";
import { Events } from "./events.ts";
import { openReceipt, ReceiptError, sealReceipt } from "./refresh-receipt.ts";
import {
	expireRefreshReceipts,
	Receipt,
	Token as TokenRow,
	type RevokeFamily,
	type TokenPair,
	validFamily,
} from "./refresh-schema.ts";

const Token = Schema.Struct({
	...TokenRow.fields,
	rotated_to: Schema.NullOr(Schema.String),
	rotated_at: Schema.NullOr(Schema.Int),
});

/** Hash-only credentials plus a short-lived encrypted receipt. All transitions own one boot SQL transaction. */
export const makeTokens = <E, R>(
	verify: (params: RevokeFamily, proof: AssertionProof) => Effect.Effect<void, E, R>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const events = yield* Events;
		const lock = yield* EditLock;
		const { hash, random } = authSecrets(crypto);

		const event = (
			type: string,
			family: string,
			agent: string,
			now: number,
			payload: Schema.Json,
			level: "info" | "warn" = "info",
		) =>
			events.writeBoot({
				at: now,
				type,
				level,
				actor: agent,
				instance: family,
				generation: 0,
				request_id: null,
				topic: null,
				message_id: null,
				payload,
			});
		const revoke = (family: string, actor: string, reason: "human" | "reuse", now: number) =>
			Effect.gen(function* () {
				const rows = yield* sql`SELECT id FROM tokens WHERE family=${family}`;
				if (!rows.length) return yield* refuse("family_not_found");
				const active = yield* sql`SELECT id FROM tokens WHERE family=${family} AND revoked_at IS NULL LIMIT 1`;
				if (!active.length) return { family, revoked: true as const };
				yield* sql`UPDATE tokens SET revoked_at=${now} WHERE family=${family} AND revoked_at IS NULL`;
				yield* sql`DELETE FROM refresh_receipts WHERE family=${family}`;
				yield* sql`DELETE FROM refresh_idempotency WHERE family=${family}`;
				yield* lock.revokeFamily(family);
				yield* event(
					"token.family_revoked",
					family,
					actor,
					now,
					{ family, reason },
					reason === "reuse" ? "warn" : "info",
				);
				return { family, revoked: true as const };
			});
		const revokeFamily = (params: RevokeFamily, proof: AssertionProof, sessionId: string) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (!validFamily(params.family)) return yield* refuse("invalid_request");
						yield* verify(params, proof);
						const now = yield* Clock.currentTimeMillis;
						const session = yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`;
						if (!session.length) return yield* refuse("session_invalid");
						yield* expireRefreshReceipts(sql, now);
						return yield* revoke(params.family, "rahul", "human", now);
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);
		const refreshTokens = (secret: string, idempotencyKey?: string) =>
			committed(
				sql,
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					yield* expireRefreshReceipts(sql, now);
					if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return yield* refuse("refresh_invalid");
					if (idempotencyKey !== undefined && !/^[\x20-\x7e]{1,128}$/.test(idempotencyKey))
						return yield* refuse("invalid_request");
					const digest = yield* hash(secret);
					const row = (yield* sql`SELECT * FROM tokens WHERE hash=${digest} AND kind='refresh'`.pipe(
						decodeRows(Token),
						Effect.mapError(() => new ReceiptError({})),
					))[0];
					if (!row) return yield* refuse("refresh_invalid");
					if (row.revoked_at !== null) return yield* refuse("family_revoked");
					if (row.expires_at <= now) return yield* refuse("refresh_invalid");
					const keyHash = idempotencyKey === undefined ? null : yield* hash(idempotencyKey);
					const checkKey = Effect.gen(function* () {
						if (keyHash !== null) {
							const bound =
								yield* sql`SELECT predecessor FROM refresh_idempotency WHERE family=${row.family} AND key_hash=${keyHash}`.pipe(
									decodeRows(Schema.Struct({ predecessor: Schema.String })),
								);
							if (bound[0] && bound[0].predecessor !== row.id) return yield* refuse("idempotency_conflict");
						}
					});
					const bind = (deadline: number) =>
						keyHash === null
							? Effect.void
							: sql`INSERT INTO refresh_idempotency(family,key_hash,predecessor,expires_at) VALUES(${row.family},${keyHash},${row.id},${deadline}) ON CONFLICT(family,key_hash) DO NOTHING`.pipe(
									Effect.asVoid,
								);
					if (row.rotated_to !== null) {
						if (row.rotated_at === null) return yield* new ReceiptError({});
						const deadline = row.rotated_at + 60_000;
						if (now >= deadline) {
							const used =
								yield* sql`SELECT id FROM tokens WHERE pair_id=(SELECT pair_id FROM tokens WHERE id=${row.rotated_to} AND family=${row.family} AND kind='refresh') AND family=${row.family} AND last_used_at IS NOT NULL LIMIT 1`;
							if (!used.length) return yield* refuse("refresh_invalid");
							yield* revoke(row.family, "boot", "reuse", now);
							return yield* refuse("family_revoked");
						}
						yield* checkKey;
						const receipt = (yield* sql`SELECT * FROM refresh_receipts WHERE predecessor=${row.id}`.pipe(
							decodeRows(Receipt),
						))[0];
						if (
							!receipt ||
							receipt.family !== row.family ||
							receipt.successor_refresh_id !== row.rotated_to ||
							receipt.expires_at !== deadline
						)
							return yield* new ReceiptError({});
						const pair = yield* openReceipt(secret, receipt);
						const accessHash = yield* hash(pair.access),
							refreshHash = yield* hash(pair.refresh);
						const successors =
							yield* sql`SELECT * FROM tokens WHERE family=${row.family} AND (id=${receipt.successor_access_id} OR id=${receipt.successor_refresh_id})`.pipe(
								decodeRows(Token),
							);
						const access = successors.find(
							(token) => token.id === receipt.successor_access_id && token.kind === "access",
						);
						const refresh = successors.find(
							(token) => token.id === receipt.successor_refresh_id && token.kind === "refresh",
						);
						if (
							!access ||
							!refresh ||
							access.pair_id !== refresh.pair_id ||
							access.revoked_at !== null ||
							refresh.revoked_at !== null ||
							access.hash !== accessHash ||
							refresh.hash !== refreshHash ||
							access.expires_at !== pair.expires_at ||
							refresh.expires_at !== pair.refresh_expires_at ||
							pair.family !== row.family ||
							pair.agent !== row.agent ||
							pair.label !== row.label ||
							pair.scopes.length !== row.scopes.length ||
							pair.scopes.some((scope, index) => scope !== row.scopes[index])
						)
							return yield* new ReceiptError({});
						yield* bind(deadline);
						return pair;
					}
					yield* checkKey;
					// The exact pair is the durable grant, including for human mints without enrollment.
					const current = yield* sql`SELECT * FROM tokens WHERE family=${row.family} AND pair_id=${row.pair_id}`.pipe(
						decodeRows(Token),
						Effect.mapError(() => new ReceiptError({})),
					);
					const access = current.find((token) => token.kind === "access");
					const refresh = current.find((token) => token.kind === "refresh");
					if (
						current.length !== 2 ||
						!access ||
						!refresh ||
						refresh.id !== row.id ||
						refresh.hash !== digest ||
						access.agent !== row.agent ||
						access.label !== row.label ||
						access.created_at !== row.created_at ||
						access.revoked_at !== null ||
						access.rotated_to !== null ||
						access.rotated_at !== null ||
						row.rotated_at !== null ||
						row.scopes.length === 0 ||
						new Set(row.scopes).size !== row.scopes.length ||
						new Set(access.scopes).size !== access.scopes.length ||
						access.scopes.length !== row.scopes.length ||
						access.scopes.some((scope) => !row.scopes.includes(scope))
					)
						return yield* new ReceiptError({});
					const accessMillis = access.expires_at - access.created_at;
					const refreshMillis = row.expires_at - row.created_at;
					if (
						!(accessMillis === 86_400_000 && refreshMillis === 2_592_000_000) &&
						!(accessMillis === 604_800_000 && refreshMillis === 7_776_000_000)
					)
						return yield* new ReceiptError({});
					const pair: TokenPair = {
						access: yield* random,
						refresh: yield* random,
						expires_at: now + accessMillis,
						refresh_expires_at: now + refreshMillis,
						scopes: row.scopes,
						family: row.family,
						agent: row.agent,
						label: row.label,
					};
					const pairId = `p_${yield* random}`,
						accessId = `t_${yield* random}`,
						refreshId = `t_${yield* random}`;
					const scopes = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Scope)))(row.scopes);
					for (const [id, kind, value, expires] of [
						[accessId, "access", pair.access, pair.expires_at],
						[refreshId, "refresh", pair.refresh, pair.refresh_expires_at],
					] as const) {
						const tokenHash = yield* hash(value);
						yield* sql`INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at) VALUES(${id},${pairId},${row.family},${row.agent},${kind},${tokenHash},${row.label},${scopes},${expires},${now})`;
					}
					const deadline = now + 60_000;
					const receipt = yield* sealReceipt(
						secret,
						{
							predecessor: row.id,
							family: row.family,
							successor_access_id: accessId,
							successor_refresh_id: refreshId,
							expires_at: deadline,
						},
						pair,
					);
					yield* sql`INSERT INTO refresh_receipts ${sql.insert(receipt)}`;
					yield* sql`UPDATE tokens SET rotated_to=${refreshId},rotated_at=${now},last_used_at=${now} WHERE id=${row.id}`;
					yield* bind(deadline);
					yield* event("token.refreshed", row.family, row.agent, now, { family: row.family });
					return pair;
				}).pipe(captureRefusal(Schema.is(AuthError))),
			);
		return { refreshTokens, revokeFamily };
	});
