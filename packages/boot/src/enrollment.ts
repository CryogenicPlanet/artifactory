import { authSecrets, refuse, committed, captureRefusal } from "./auth-primitives.ts";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Clock, Crypto, Effect, Schema, Struct, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError } from "./auth.ts";
import { Events } from "./events.ts";
import { expireRefreshReceipts, Token } from "./refresh-schema.ts";
import { Scope, type EnrollmentDecision, validDecision } from "./enrollment-schema.ts";

export interface AssertionProof {
	readonly id: string;
	readonly response: AuthenticationResponseJSON;
}
export interface VerifiedIdentity {
	readonly id: string;
	readonly agent: string;
	readonly kind: "human" | "agent";
	readonly label: string;
	readonly scopes: readonly string[];
	readonly expiresAt: number;
}
const enrollmentRow = Schema.Struct({
	id: Schema.String,
	device_secret_hash: Schema.String,
	user_code: Schema.String,
	agent_name: Schema.String,
	kind: Schema.String,
	host: Schema.String,
	status: Schema.String,
	family: Schema.String,
	created_at: Schema.Int,
	expires_at: Schema.Int,
	collected_at: Schema.NullOr(Schema.Int),
	scopes: Schema.NullOr(Schema.String),
	access_seconds: Schema.NullOr(Schema.Int),
	refresh_seconds: Schema.NullOr(Schema.Int),
});
const tokenRow = Token.mapFields(Struct.pick(["id", "family", "agent", "label", "scopes", "expires_at", "revoked_at"]));

/** Enrollment and collection share the passkey service's admission mutex and boot transaction. */
export const makeEnrollment = <E, R>(
	verify: (params: EnrollmentDecision, proof: AssertionProof) => Effect.Effect<void, E, R>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const events = yield* Events;
		const { hash, random } = authSecrets(crypto);
		const read = (id: string) =>
			sql`SELECT * FROM enrollments WHERE id=${id}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(enrollmentRow))),
				Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : refuse("enrollment_invalid"))),
			);
		const enrollmentInfo = (id: string) =>
			Effect.gen(function* () {
				const row = yield* read(id);
				return {
					id: row.id,
					name: row.agent_name,
					kind: row.kind,
					host: row.host,
					user_code: row.user_code,
					status:
						row.expires_at <= (yield* Clock.currentTimeMillis) && row.status !== "collected" && row.status !== "denied"
							? "expired"
							: row.status,
					expires_at: row.expires_at,
				};
			});
		const createEnrollment = (input: { readonly name: string; readonly kind: string; readonly host: string }) =>
			Effect.gen(function* () {
				if (
					!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.name) ||
					input.name === "rahul" ||
					input.name === "boot" ||
					!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.kind) ||
					!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(input.host)
				)
					return yield* refuse("invalid_request");
				const id = `e_${yield* random}`,
					secret = yield* random,
					family = `f_${yield* random}`;
				const digest = yield* hash(secret),
					code = Buffer.from(yield* crypto.randomBytes(3))
						.toString("hex")
						.toUpperCase();
				const now = yield* Clock.currentTimeMillis,
					expires = now + 600_000;
				yield* sql`INSERT INTO enrollments(id,device_secret_hash,user_code,agent_name,kind,host,status,family,created_at,expires_at)
   VALUES(${id},${digest},${code},${input.name},${input.kind},${input.host},'pending',${family},${now},${expires})`;
				return { id, device_secret: secret, user_code: code, expires_at: expires };
			});
		const decideEnrollment = (params: EnrollmentDecision, proof: AssertionProof) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (!validDecision(params)) return yield* refuse("invalid_request");
						yield* verify(params, proof);
						// A valid proof is consumed even if the pending enrollment became terminal. SQL failures still roll everything back.
						return yield* Effect.gen(function* () {
							const row = yield* read(params.id),
								now = yield* Clock.currentTimeMillis;
							if (row.expires_at <= now) return yield* refuse("enrollment_expired");
							if (row.status !== "pending") return yield* refuse("enrollment_decided");
							const scopes = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
								["read", "write", "fs"].filter((scope) => params.scopes.some((value) => value === scope)),
							);
							const access = params.long_lived ? 604800 : 86400,
								refresh = params.long_lived ? 7776000 : 2592000;
							yield* sql`UPDATE enrollments SET status=${params.decision === "approve" ? "approved" : "denied"},scopes=${scopes},access_seconds=${access},refresh_seconds=${refresh} WHERE id=${params.id}`;
							yield* events.writeBoot({
								at: now,
								type: params.decision === "approve" ? "enrollment.approved" : "enrollment.denied",
								level: "info",
								actor: "rahul",
								instance: null,
								generation: 0,
								request_id: null,
								topic: null,
								message_id: null,
								payload: {
									id: params.id,
									agent: row.agent_name,
									label: row.host,
									scopes: params.scopes,
									long_lived: params.long_lived,
								},
							});
							return { status: params.decision === "approve" ? "approved" : "denied" };
						}).pipe(captureRefusal(Schema.is(AuthError)));
					}),
				),
			);
		const collectEnrollment = (id: string, secret: string) =>
			mutex.withPermit(
				sql.withTransaction(
					Effect.gen(function* () {
						if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return yield* refuse("device_secret_invalid");
						const digest = yield* hash(secret);
						const rows = yield* sql`SELECT * FROM enrollments WHERE id=${id} AND device_secret_hash=${digest}`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(enrollmentRow))),
						);
						const row = rows[0];
						if (!row) return yield* refuse("device_secret_invalid");
						if (row.status === "collected") return yield* refuse("already_collected");
						if (row.status === "denied") return yield* refuse("enrollment_denied");
						const now = yield* Clock.currentTimeMillis;
						if (row.expires_at <= now) return yield* refuse("enrollment_expired");
						if (row.status === "pending") return { status: "pending" as const, expires_at: row.expires_at };
						if (row.status !== "approved" || !row.scopes || !row.access_seconds || !row.refresh_seconds)
							return yield* refuse("enrollment_invalid");
						const scopes = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Scope)))(row.scopes);
						const access = yield* random,
							refresh = yield* random,
							pair = `p_${yield* random}`;
						const expires = now + row.access_seconds * 1000,
							refreshExpires = now + row.refresh_seconds * 1000;
						for (const [kind, token, expiry] of [
							["access", access, expires],
							["refresh", refresh, refreshExpires],
						] as const) {
							const tokenId = `t_${yield* random}`,
								tokenHash = yield* hash(token);
							yield* sql`INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at)
    VALUES(${tokenId},${pair},${row.family},${row.agent_name},${kind},${tokenHash},${row.host},${row.scopes},${expiry},${now})`;
						}
						yield* sql`UPDATE enrollments SET status='collected',collected_at=${now} WHERE id=${id}`;
						return {
							status: "collected" as const,
							agent: row.agent_name,
							access,
							refresh,
							expires_at: expires,
							refresh_expires_at: refreshExpires,
							scopes,
							label: row.host,
							family: row.family,
						};
					}),
				),
			);
		const authenticateAccess = (token: string) =>
			sql.withTransaction(
				Effect.gen(function* () {
					if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return yield* refuse("token_invalid");
					const digest = yield* hash(token),
						now = yield* Clock.currentTimeMillis;
					const rows =
						yield* sql`SELECT id,family,agent,label,scopes,expires_at,revoked_at FROM tokens WHERE hash=${digest} AND kind='access'`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(tokenRow))),
						);
					const row = rows[0];
					if (!row || row.revoked_at !== null) return yield* refuse("token_invalid");
					if (row.expires_at <= now) return yield* refuse("token_expired");
					yield* sql`UPDATE tokens SET last_used_at=${now} WHERE id=${row.id}`;
					yield* expireRefreshReceipts(sql, now);
					return {
						id: row.family,
						agent: row.agent,
						kind: "agent",
						label: row.label,
						scopes: row.scopes,
						expiresAt: row.expires_at,
					} satisfies VerifiedIdentity;
				}),
			);
		return { createEnrollment, enrollmentInfo, decideEnrollment, collectEnrollment, authenticateAccess };
	});
