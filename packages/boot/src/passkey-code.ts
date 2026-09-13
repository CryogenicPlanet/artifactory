import { lockBootWrite } from "./boot-write-lock.ts";
// Effect Crypto has no constant-time comparison primitive.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { timingSafeEqual } from "node:crypto";
import { authSecrets, captureRefusal, committed, refuse } from "./auth-primitives.ts";
import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Clock, Crypto, Effect, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError, type AuthConfig } from "./auth.ts";
import { allowedParties, codeTargetParty, originRelyingParty, type RelyingParty } from "./auth-origins.ts";
import type { AssertionProof } from "./enrollment.ts";
import { Events } from "./events.ts";
import { humanAgent } from "./human-agent.ts";
import { canonicalPasskeyCode, type PasskeyCodeParams } from "./passkey-code-schema.ts";
import { OriginProofError, originProofPath } from "./origin-proof.ts";

/** A code is SELECTOR-SECRET and shown once, so it lives briefly. The selector names the live code and is not
 * secret; only the right selector with a wrong secret counts, and wrong secrets lock redemption rather than destroy
 * the code, because redemption is public and its Origin header is forgeable. */
export const passkeyCodeLifetimeMs = 10 * 60_000;
const passkeyCodeAttempts = 3;
export const passkeyCodeLockoutMs = 60_000;
/** A named domain's proof lives only as long as one fetch. */
const originProofLifetimeMs = 30_000;

const codeRow = Schema.Struct({
	id: Schema.String,
	selector: Schema.String,
	hash: Schema.String,
	origin: Schema.NullOr(Schema.String),
	failures: Schema.Finite,
	locked_until: Schema.Finite,
	proven: Schema.Finite,
	proof_id: Schema.NullOr(Schema.String),
	proof_nonce: Schema.NullOr(Schema.String),
	proof_expires_at: Schema.NullOr(Schema.Finite),
	expires_at: Schema.Finite,
});
type CodeRow = typeof codeRow.Type;
const challengeRow = Schema.Struct({
	challenge: Schema.String,
	setup_generation: Schema.NullOr(Schema.String),
	expires_at: Schema.Finite,
});

/** One live code at a time. It adds a passkey for a human who already has one, on this or a new origin. */
export const makePasskeyCodes = <E, R, S, SE, SR>(
	config: AuthConfig,
	verify: (binding: string, proof: AssertionProof) => Effect.Effect<void, E, R>,
	newSession: (origin: string) => Effect.Effect<S, SE, SR>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const events = yield* Events;
		const { hash, random } = authSecrets(crypto);
		const event = (type: string, level: "info" | "warn", payload: Schema.Json) =>
			Effect.gen(function* () {
				yield* events.writeBoot({
					at: yield* Clock.currentTimeMillis,
					type,
					level,
					actor: humanAgent,
					instance: null,
					generation: 0,
					request_id: null,
					topic: null,
					message_id: null,
					payload,
				});
			});
		const noPasskeys = Effect.map(sql`SELECT id FROM passkeys LIMIT 1`, (rows) => rows.length === 0);
		const currentCode = Effect.gen(function* () {
			const rows =
				yield* sql`SELECT id, selector, hash, origin, failures, locked_until, proven, proof_id, proof_nonce, proof_expires_at, expires_at FROM passkey_codes`;
			return (yield* Schema.decodeUnknownEffect(Schema.Array(codeRow))(rows))[0];
		});
		const codeBySelector = (selector: string) =>
			Effect.gen(function* () {
				const rows =
					yield* sql`SELECT id, selector, hash, origin, failures, locked_until, proven, proof_id, proof_nonce, proof_expires_at, expires_at FROM passkey_codes WHERE selector=${selector}`;
				return (yield* Schema.decodeUnknownEffect(Schema.Array(codeRow))(rows))[0];
			});
		const discard = Effect.gen(function* () {
			yield* sql`DELETE FROM passkey_codes`;
			yield* sql`DELETE FROM auth_challenges WHERE ceremony='passkey.redeem'`;
		});
		/** A bound code redeems only on its own origin; an unbound code on any origin already allowed. */
		const partyFor = (code: CodeRow, origin: string | undefined) =>
			Effect.gen(function* () {
				if (origin === undefined || (code.origin !== null && origin !== code.origin)) return null;
				const allowed = (yield* allowedParties(sql, config)).find((party) => party.expectedOrigin === origin);
				const party: RelyingParty | null = allowed ?? (code.origin === null ? null : originRelyingParty(code.origin));
				return party;
			});

		const createPasskeyCode = (params: PasskeyCodeParams, proof: AssertionProof, sessionId: string) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (params.origin !== undefined && !codeTargetParty(params.origin, config))
							return yield* refuse("invalid_request");
						yield* verify(yield* canonicalPasskeyCode(params, sessionId), proof);
						const now = yield* Clock.currentTimeMillis;
						if (!(yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`).length)
							return yield* refuse("session_invalid");
						const selector = Buffer.from(yield* crypto.randomBytes(6))
							.toString("hex")
							.toUpperCase();
						const secret = Buffer.from(yield* crypto.randomBytes(8))
							.toString("hex")
							.toUpperCase();
						const code = `${selector}-${secret}`;
						const origin = params.origin ?? null;
						const expiresAt = now + passkeyCodeLifetimeMs;
						// A newer code replaces the previous one and every ceremony started with it.
						yield* discard;
						yield* sql`INSERT INTO passkey_codes (id, selector, hash, origin, failures, locked_until, proven, expires_at, created_at)
				VALUES (${yield* random}, ${selector}, ${yield* hash(secret)}, ${origin}, 0, 0, 0, ${expiresAt}, ${now})`;
						yield* event("auth.passkey_code_created", "info", { origin, expires_at: expiresAt });
						return { code, origin, expires_at: expiresAt };
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);

		const revokePasskeyCode = (sessionId: string) =>
			mutex.withPermit(
				sql.withTransaction(
					Effect.gen(function* () {
						yield* lockBootWrite(sql);
						const now = yield* Clock.currentTimeMillis;
						if (!(yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`).length)
							return yield* refuse("session_invalid");
						const code = yield* currentCode;
						yield* discard;
						if (code) yield* event("auth.passkey_code_revoked", "info", { origin: code.origin });
						return { revoked: code !== undefined && code.expires_at > now };
					}),
				),
			);

		const admitRedemption = (input: string, origin: string | undefined) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						// Adding a first passkey remains /setup's job.
						if (yield* noPasskeys) return yield* refuse("setup_required");
						const now = yield* Clock.currentTimeMillis;
						// An unknown selector or a malformed code is refused without counting or touching any code.
						const parts = /^([0-9A-F]{12})-([0-9A-F]{16})$/.exec(input.trim().toUpperCase());
						const selector = parts?.[1];
						const secret = parts?.[2];
						if (!selector || !secret) return yield* refuse("passkey_code_invalid");
						const code = yield* codeBySelector(selector);
						if (!code) return yield* refuse("passkey_code_invalid");
						if (code.expires_at <= now) {
							yield* discard;
							return yield* refuse("passkey_code_invalid");
						}
						// An origin that is neither allowed nor bound is refused before the secret is examined and spends nothing.
						// It gets the same refusal as an unknown selector, so a request cannot learn whether a selector is live.
						const party = yield* partyFor(code, origin);
						if (!party) return yield* refuse("passkey_code_invalid");
						if (code.locked_until > now) return yield* refuse("passkey_code_locked");
						// Only the right selector with a wrong secret counts. The stored value is a hash of the secret,
						// compared in constant time.
						const digest = Buffer.from(yield* hash(secret));
						const stored = Buffer.from(code.hash);
						if (digest.length !== stored.length || !timingSafeEqual(digest, stored)) {
							const failures = code.failures + 1;
							// From the third wrong secret, lock for 60 seconds, doubling with each further wrong secret.
							// The code keeps its TTL, so a lockout delays its owner but never destroys it.
							const lockedUntil =
								failures >= passkeyCodeAttempts
									? now + passkeyCodeLockoutMs * 2 ** Math.min(failures - passkeyCodeAttempts, 10)
									: 0;
							yield* sql`UPDATE passkey_codes SET failures=${failures}, locked_until=${lockedUntil} WHERE id=${code.id}`;
							yield* event("auth.passkey_code_refused", "warn", {
								reason: "passkey_code_invalid",
								origin: party.expectedOrigin,
								failures,
								locked_until: lockedUntil === 0 ? null : lockedUntil,
							});
							return yield* refuse("passkey_code_invalid");
						}
						// A domain named on the code and not yet allowed must first serve a one-time proof the board fetches.
						// Only the code holder reaches this point, and a failed proof spends no attempt.
						const pending =
							code.origin !== null &&
							!(yield* allowedParties(sql, config)).some((allowed) => allowed.expectedOrigin === party.expectedOrigin);
						if (pending && code.proven !== 1) {
							// One proof fetch per code at a time: a concurrent redemption would start another fetch.
							if (code.proof_id !== null && code.proof_expires_at !== null && code.proof_expires_at > now)
								return yield* refuse("origin_unproven");
							const proofId = yield* random;
							const nonce = yield* random;
							yield* sql`UPDATE passkey_codes SET proof_id=${proofId}, proof_nonce=${nonce}, proof_expires_at=${now + originProofLifetimeMs} WHERE id=${code.id}`;
							return { _tag: "proof" as const, proofId, url: `${party.expectedOrigin}${originProofPath(proofId)}` };
						}
						const existing = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))(
							yield* sql`SELECT id FROM passkeys WHERE COALESCE(rp_id, ${config.rpId})=${party.rpId}`,
						);
						const options = yield* Effect.tryPromise({
							try: () =>
								generateRegistrationOptions({
									rpName: "chirp",
									rpID: party.rpId,
									userName: "human",
									userID: new TextEncoder().encode("comms-human"),
									attestationType: "none",
									authenticatorSelection: { residentKey: "required", userVerification: "required" },
									excludeCredentials: existing.map(({ id }) => ({ id })),
								}),
							catch: () => new AuthError({ code: "registration_failed" }),
						});
						const id = yield* random;
						yield* sql`DELETE FROM auth_challenges WHERE expires_at <= ${now}`;
						yield* sql`INSERT INTO auth_challenges (id, challenge, ceremony, setup_generation, expires_at)
				VALUES (${id}, ${options.challenge}, 'passkey.redeem', ${code.id}, ${now + 120_000})`;
						return { _tag: "options" as const, id, options };
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);

		/** Consume the proof, and mark the code proven only if the fetched body is exactly its nonce. */
		const proveOrigin = (proofId: string, body: string | null) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis;
						const code = (yield* Schema.decodeUnknownEffect(Schema.Array(codeRow))(
							yield* sql`SELECT id, selector, hash, origin, failures, locked_until, proven, proof_id, proof_nonce, proof_expires_at, expires_at FROM passkey_codes WHERE proof_id=${proofId}`,
						))[0];
						if (!code) return yield* refuse("origin_unproven");
						yield* sql`UPDATE passkey_codes SET proof_id=NULL, proof_nonce=NULL, proof_expires_at=NULL WHERE id=${code.id}`;
						const expected = Buffer.from(code.proof_nonce ?? "");
						const received = Buffer.from(body ?? "");
						const matched =
							code.proof_nonce !== null &&
							body !== null &&
							code.proof_expires_at !== null &&
							code.proof_expires_at > now &&
							expected.length === received.length &&
							timingSafeEqual(expected, received);
						if (!matched) {
							yield* event("auth.origin_proof_failed", "warn", { origin: code.origin });
							return yield* refuse("origin_unproven");
						}
						yield* sql`UPDATE passkey_codes SET proven=1 WHERE id=${code.id}`;
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);
		/** The value a newly named domain must serve back to the board, while its proof is live. */
		const originProofNonce = (proofId: string) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				const rows = yield* Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({
							proof_nonce: Schema.NullOr(Schema.String),
							proof_expires_at: Schema.NullOr(Schema.Finite),
						}),
					),
				)(yield* sql`SELECT proof_nonce, proof_expires_at FROM passkey_codes WHERE proof_id=${proofId}`);
				const row = rows[0];
				return row?.proof_nonce && row.proof_expires_at !== null && row.proof_expires_at > now ? row.proof_nonce : null;
			});
		/** Check the code. If its domain needs proving, fetch the proof with no lock held, then check again. */
		const startPasskeyCodeRedemption = (
			input: string,
			origin: string | undefined,
			fetchProof: (url: string) => Effect.Effect<string, unknown> = () =>
				Effect.fail(new OriginProofError({ reason: "network" })),
		) =>
			Effect.gen(function* () {
				const first = yield* admitRedemption(input, origin);
				if (first._tag === "options") return { id: first.id, options: first.options };
				const body = yield* fetchProof(first.url).pipe(
					Effect.map((value): string | null => value),
					Effect.orElseSucceed(() => null),
				);
				yield* proveOrigin(first.proofId, body);
				const second = yield* admitRedemption(input, origin);
				if (second._tag === "proof") return yield* refuse("origin_unproven");
				return { id: second.id, options: second.options };
			});

		const finishPasskeyCodeRedemption = (id: string, response: RegistrationResponseJSON, origin: string | undefined) =>
			mutex.withPermit(
				sql.withTransaction(
					Effect.gen(function* () {
						yield* lockBootWrite(sql);
						if (yield* noPasskeys) return yield* refuse("setup_required");
						const challenge = (yield* Schema.decodeUnknownEffect(Schema.Array(challengeRow))(
							yield* sql`SELECT challenge, setup_generation, expires_at FROM auth_challenges
				WHERE id=${id} AND ceremony='passkey.redeem'`,
						))[0];
						const code = yield* currentCode;
						if (!challenge || !code || challenge.setup_generation !== code.id)
							return yield* refuse("challenge_invalid");
						const party = yield* partyFor(code, origin);
						if (!party) return yield* refuse("origin_invalid");
						// Activating a domain requires the board to have fetched its proof from that domain.
						if (
							code.proven !== 1 &&
							!(yield* allowedParties(sql, config)).some((allowed) => allowed.expectedOrigin === party.expectedOrigin)
						)
							return yield* refuse("origin_unproven");
						const verified = yield* Effect.tryPromise({
							try: () =>
								verifyRegistrationResponse({
									response,
									expectedChallenge: challenge.challenge,
									expectedOrigin: party.expectedOrigin,
									expectedRPID: party.rpId,
									requireUserVerification: true,
								}),
							catch: () => new AuthError({ code: "registration_invalid" }),
						});
						if (!verified.verified) return yield* refuse("registration_invalid");
						const now = yield* Clock.currentTimeMillis;
						if (challenge.expires_at <= now || code.expires_at <= now) return yield* refuse("challenge_invalid");
						const credential = verified.registrationInfo.credential;
						if ((yield* sql`SELECT id FROM passkeys WHERE id=${credential.id}`).length)
							return yield* refuse("passkey_exists");
						const publicKey = Buffer.from(credential.publicKey).toString("base64url");
						const transports = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
							credential.transports ?? [],
						);
						const label = `Added with a code on ${party.rpId}`.slice(0, 128);
						yield* sql`INSERT INTO passkeys (id, public_key, counter, transports, label, created_at, rp_id)
				VALUES (${credential.id}, ${publicKey}, ${credential.counter}, ${transports}, ${label}, ${now}, ${party.rpId})`;
						// The fetched proof showed that the domain routes to this board.
						const activated = !(yield* allowedParties(sql, config)).some(
							(allowed) => allowed.expectedOrigin === party.expectedOrigin,
						);
						if (activated)
							yield* sql`INSERT INTO auth_origins (origin, rp_id, created_at) VALUES (${party.expectedOrigin}, ${party.rpId}, ${now})`;
						yield* discard;
						yield* event("auth.passkey_code_redeemed", "info", {
							origin: party.expectedOrigin,
							rp_id: party.rpId,
							activated,
						});
						return yield* newSession(party.expectedOrigin);
					}),
				),
			);

		return {
			createPasskeyCode,
			revokePasskeyCode,
			startPasskeyCodeRedemption,
			finishPasskeyCodeRedemption,
			originProofNonce,
		};
	});
