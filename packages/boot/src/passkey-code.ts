import { lockBootWrite } from "./boot-write-lock.ts";
import { authSecrets, captureRefusal, committed, refuse } from "./auth-primitives.ts";
import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Clock, Crypto, Effect, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError, type AuthConfig } from "./auth.ts";
import { allowedParties, originRelyingParty, type RelyingParty } from "./auth-origins.ts";
import type { AssertionProof } from "./enrollment.ts";
import { Events } from "./events.ts";
import { humanAgent } from "./human-agent.ts";
import { canonicalPasskeyCode, type PasskeyCodeParams } from "./passkey-code-schema.ts";

/** A code is shown once, so it lives briefly and allows as few wrong guesses as a setup code. */
export const passkeyCodeLifetimeMs = 10 * 60_000;
const passkeyCodeAttempts = 3;

const codeRow = Schema.Struct({
	id: Schema.String,
	hash: Schema.String,
	origin: Schema.NullOr(Schema.String),
	failures: Schema.Finite,
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
	newSession: Effect.Effect<S, SE, SR>,
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
			const rows = yield* sql`SELECT id, hash, origin, failures, expires_at FROM passkey_codes`;
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
						if (params.origin !== undefined && !originRelyingParty(params.origin))
							return yield* refuse("invalid_request");
						yield* verify(yield* canonicalPasskeyCode(params, sessionId), proof);
						const now = yield* Clock.currentTimeMillis;
						if (!(yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`).length)
							return yield* refuse("session_invalid");
						const code = Buffer.from(yield* crypto.randomBytes(8))
							.toString("hex")
							.toUpperCase();
						const origin = params.origin ?? null;
						const expiresAt = now + passkeyCodeLifetimeMs;
						// A newer code replaces the previous one and every ceremony started with it.
						yield* discard;
						yield* sql`INSERT INTO passkey_codes (id, hash, origin, failures, expires_at, created_at)
				VALUES (${yield* random}, ${yield* hash(code)}, ${origin}, 0, ${expiresAt}, ${now})`;
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

		const startPasskeyCodeRedemption = (input: string, origin: string | undefined) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						// Adding a first passkey remains /setup's job.
						if (yield* noPasskeys) return yield* refuse("setup_required");
						const now = yield* Clock.currentTimeMillis;
						const code = yield* currentCode;
						if (!code || code.expires_at <= now) {
							if (code) yield* discard;
							return yield* refuse("passkey_code_invalid");
						}
						const failed = (refusal: "passkey_code_invalid" | "origin_invalid") =>
							Effect.gen(function* () {
								const exhausted = code.failures + 1 >= passkeyCodeAttempts;
								if (exhausted) yield* discard;
								else yield* sql`UPDATE passkey_codes SET failures=${code.failures + 1} WHERE id=${code.id}`;
								yield* event("auth.passkey_code_refused", "warn", {
									reason: refusal,
									origin: origin ?? null,
									exhausted,
								});
								return yield* refuse(refusal);
							});
						// Comparing SHA-256 digests of a random code; the stored value is never the code itself.
						// Codes are uppercase hex, so a lowercase transcription is the same code rather than a wasted attempt.
						if ((yield* hash(input.trim().toUpperCase())) !== code.hash) return yield* failed("passkey_code_invalid");
						const party = yield* partyFor(code, origin);
						if (!party) return yield* failed("origin_invalid");
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
						return { id, options };
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);

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
						// Reaching the board from the bound origin is the proof that the domain routes here.
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
						return yield* newSession;
					}),
				),
			);

		return {
			createPasskeyCode,
			revokePasskeyCode,
			startPasskeyCodeRedemption,
			finishPasskeyCodeRedemption,
		};
	});
