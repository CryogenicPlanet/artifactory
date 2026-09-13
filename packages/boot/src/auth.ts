import { on } from "@comms/storage/dialect";
import { lockBootWrite } from "./boot-write-lock.ts";
import { makeSettings } from "./settings.ts";
import { canonicalSettings } from "./settings-schema.ts";
import { authSecrets, refuse, committed, captureRefusal } from "./auth-primitives.ts";
// Effect Crypto has no constant-time comparison primitive.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { timingSafeEqual } from "node:crypto";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Clock, Console, Context, Crypto, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { makeEnrollment, type AssertionProof } from "./enrollment.ts";
import { makeAccountQueries } from "./account-queries.ts";
import { makePasskeyManagement } from "./passkey-management.ts";
import { makeDatabaseRestoreAuth } from "./database-restore-auth.ts";
import { canonicalDatabaseRestore, canonicalGenerationRestore } from "./database-restore-schema.ts";
import { canonicalSourceReset, validSeedDigest } from "./source-reset-schema.ts";
import { makeTokenMint } from "./token-mint.ts";
import { canonicalMint } from "./token-mint-schema.ts";
import { makeTokens } from "./tokens.ts";
import { makeLockBreak, canonicalLockBreak, type BreakLock } from "./lock-break.ts";
import { canonicalRevocation, type RevokeFamily } from "./refresh-schema.ts";
import { canonicalDecision, type EnrollmentDecision } from "./enrollment-schema.ts";
import { allowedParties, makeOriginManagement, passkeyOriginMismatch, type RelyingParty } from "./auth-origins.ts";
import { makeActionAssertions, restartBinding } from "./action-assertions.ts";
import { makePasskeyCodes } from "./passkey-code.ts";
import { Events } from "./events.ts";
import { humanAgent } from "./human-agent.ts";
import type { RemoveOrigin } from "./passkey-code-schema.ts";

/** The top-level origin is the primary one; boot generates absolute URLs from it. */
export interface AuthConfig extends RelyingParty {
	readonly additionalOrigins?: ReadonlyArray<RelyingParty>;
	/** Set when origins came from PUBLIC_ORIGINS, which names no RP ID for passkeys stored before RP IDs were recorded. */
	readonly originList?: boolean;
	/** Operator recovery switch read by boot from its own environment: one setup may add a passkey while passkeys exist. */
	readonly reopenSetup?: boolean;
}

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
	code: Schema.Literals([
		"already_collected",
		"assertion_invalid",
		"auth_configuration_invalid",
		"authentication_failed",
		"authentication_invalid",
		"backup_engine_mismatch",
		"backup_not_found",
		"backup_not_restorable",
		"challenge_invalid",
		"device_secret_invalid",
		"enrollment_decided",
		"enrollment_denied",
		"enrollment_expired",
		"enrollment_invalid",
		"family_not_found",
		"family_revoked",
		"generation_not_restorable",
		"idempotency_conflict",
		"invalid_request",
		"last_passkey",
		"origin_has_passkeys",
		"origin_last_passkey",
		"origin_invalid",
		"origin_not_found",
		"origin_protected",
		"origin_unproven",
		"passkey_code_invalid",
		"passkey_code_locked",
		"passkey_exists",
		"passkey_not_found",
		"passkey_origin_mismatch",
		"refresh_invalid",
		"registration_failed",
		"registration_invalid",
		"restore_in_progress",
		"scope_required",
		"session_invalid",
		"settings_conflict",
		"setup_closed",
		"setup_code_invalid",
		"setup_required",
		"token_expired",
		"token_invalid",
	]),
}) {}

const challengeRow = Schema.Struct({
	id: Schema.String,
	challenge: Schema.String,
	ceremony: Schema.String,
	// Setup nonce generation, or canonical parameters for an action-bound challenge.
	setup_generation: Schema.NullOr(Schema.String),
	expires_at: Schema.Finite,
});
const passkeyRow = Schema.Struct({
	id: Schema.String,
	public_key: Schema.String,
	counter: Schema.Finite,
	rp_id: Schema.NullOr(Schema.String),
});
const sessionRow = Schema.Struct({ id: Schema.String, expires_at: Schema.Finite });
const same = (left: string, right: string) => {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
};

/** How an operator gets back in when stored passkeys and allowed origins disagree. */
const passkeyRecoveryHint =
	"PUBLIC_ORIGINS gives each origin its hostname as RP ID, so it only keeps passkeys whose RP ID equals one of those hostnames; otherwise keep RP_ID and PUBLIC_ORIGIN. Fix it by restoring the previous origin variables, or recover by setting REOPEN_SETUP=1 and opening /setup with the code in this log, or by emptying boot's passkey table (DELETE FROM passkeys).";

/** Boot-owned passkeys and sessions. No app code or external credential issuer is involved. */
const makeAuth = (config: AuthConfig) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const bootConsole = yield* Console.Console;
		const events = yield* Events;
		const mutex = yield* Semaphore.make(1);
		const setup = yield* Ref.make<{
			readonly code: string;
			readonly generation: string;
			readonly failures: number;
		} | null>(null);
		const { hash, random } = authSecrets(crypto);
		// REOPEN_SETUP=1 lets one setup add a passkey while passkeys exist, once per boot process.
		const reopenAvailable = yield* Ref.make(config.reopenSetup === true);
		const noPasskeys = Effect.gen(function* () {
			const rows = yield* sql`SELECT id FROM passkeys LIMIT 1`;
			return rows.length === 0;
		});
		const rotateSetup = Effect.gen(function* () {
			const bytes = yield* crypto.randomBytes(8);
			const code = Buffer.from(bytes).toString("hex").toUpperCase();
			const generation = yield* random;
			yield* sql`DELETE FROM auth_challenges WHERE ceremony = 'setup'`;
			yield* Ref.set(setup, { code, generation, failures: 0 });
			yield* Effect.sync(() => bootConsole.log(`chirp: /setup is open, code ${code}`));
			return { code, generation, failures: 0 };
		});
		const setupState = Effect.gen(function* () {
			if (!(yield* noPasskeys) && !(yield* Ref.get(reopenAvailable))) {
				yield* Ref.set(setup, null);
				return null;
			}
			return (yield* Ref.get(setup)) ?? (yield* rotateSetup);
		});
		// Every boot invalidates setup ceremonies created under an earlier stdout code.
		yield* sql`DELETE FROM auth_challenges WHERE ceremony = 'setup'`;
		/** Whether stored passkeys can still sign in through an allowed origin. Read fresh each time, because passkeys
		 * and runtime origins change while boot runs. A mismatch warns; it never refuses startup. */
		const passkeyOriginState = Effect.gen(function* () {
			const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ rp_id: Schema.String })))(
				yield* sql`SELECT DISTINCT COALESCE(rp_id, ${config.rpId}) AS rp_id FROM passkeys`,
			);
			const mismatch = passkeyOriginMismatch(
				rows.map((row) => row.rp_id),
				yield* allowedParties(sql, config),
			);
			const unrecorded =
				config.originList === true && (yield* sql`SELECT id FROM passkeys WHERE rp_id IS NULL LIMIT 1`).length > 0;
			const problems = [
				...(mismatch === null ? [] : [mismatch]),
				...(unrecorded
					? [
							"some passkeys predate recorded RP IDs, and PUBLIC_ORIGINS names no RP ID for them, so they are tried under the primary origin's hostname",
						]
					: []),
			];
			return {
				ok: problems.length === 0,
				stranded: mismatch !== null,
				detail: problems.length === 0 ? null : `${problems.join("; ")}. ${passkeyRecoveryHint}`,
			};
		});
		const startupState = yield* passkeyOriginState;
		if (startupState.detail !== null)
			yield* Effect.sync(() => bootConsole.error(`chirp: WARNING passkey origins: ${startupState.detail}`));
		if (config.reopenSetup === true)
			yield* Effect.sync(() =>
				bootConsole.error(
					"chirp: WARNING REOPEN_SETUP=1 is set: /setup accepts one new passkey for the primary origin in this process even though passkeys exist. Remove the variable once you have signed in.",
				),
			);
		yield* setupState;

		const allowed = allowedParties(sql, config);
		/** Resolve an exact Origin header against configured and activated origins. */
		const relyingParty = (origin: string | undefined) =>
			allowed.pipe(
				Effect.flatMap((parties) => {
					const party = parties.find((item) => item.expectedOrigin === origin);
					return party ? Effect.succeed(party) : refuse("origin_invalid");
				}),
			);
		const saveChallenge = Effect.fn("Auth.saveChallenge")(function* (
			challenge: string,
			ceremony: string,
			generation: string | null,
		) {
			const now = yield* Clock.currentTimeMillis;
			const id = yield* random;
			yield* sql`DELETE FROM auth_challenges WHERE expires_at <= ${now}`;
			yield* sql`INSERT INTO auth_challenges (id, challenge, ceremony, setup_generation, expires_at)
			VALUES (${id}, ${challenge}, ${ceremony}, ${generation}, ${now + 120_000})`;
			return id;
		});
		const takeChallenge = Effect.fn("Auth.takeChallenge")(function* (id: string, ceremony: string) {
			const rows = yield* sql`SELECT * FROM auth_challenges WHERE id = ${id}`;
			const row = yield* Schema.decodeUnknownEffect(Schema.Array(challengeRow))(rows);
			const challenge = row[0];
			if (!challenge || challenge.ceremony !== ceremony || challenge.expires_at <= (yield* Clock.currentTimeMillis))
				return yield* refuse("challenge_invalid");
			return challenge;
		});
		/** Sessions record the origin they were issued on, so removing that origin can end them. */
		const newSession = (origin: string) =>
			Effect.gen(function* () {
				const token = yield* random;
				const id = yield* random;
				const now = yield* Clock.currentTimeMillis;
				const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
				const digest = yield* hash(token);
				yield* sql`INSERT INTO sessions (id, hash, created_at, expires_at, last_seen_at, origin) VALUES (${id}, ${digest}, ${now}, ${expiresAt}, ${now}, ${origin})`;
				return { token, id, expiresAt };
			});
		const startSetup = (party: RelyingParty) => (code: string) =>
			mutex.withPermit(
				Effect.gen(function* () {
					const state = yield* setupState;
					if (!state) return yield* refuse("setup_closed");
					// A reopened setup only adds a passkey for the primary origin.
					if (!(yield* noPasskeys) && party.expectedOrigin !== config.expectedOrigin)
						return yield* refuse("origin_invalid");
					if (!same(code, state.code)) {
						if (state.failures + 1 >= 3) yield* rotateSetup;
						else yield* Ref.set(setup, { ...state, failures: state.failures + 1 });
						return yield* refuse("setup_code_invalid");
					}
					const options = yield* Effect.tryPromise({
						try: () =>
							generateRegistrationOptions({
								rpName: "chirp",
								rpID: party.rpId,
								userName: "human",
								userID: new TextEncoder().encode("comms-human"),
								attestationType: "none",
								authenticatorSelection: { residentKey: "required", userVerification: "required" },
							}),
						catch: () => new AuthError({ code: "registration_failed" }),
					});
					return { id: yield* saveChallenge(options.challenge, "setup", state.generation), options };
				}),
			);
		const finishSetup = (party: RelyingParty) => (id: string, response: RegistrationResponseJSON) =>
			mutex.withPermit(
				sql.withTransaction(
					Effect.gen(function* () {
						yield* lockBootWrite(sql);
						const reopened = !(yield* noPasskeys);
						if (reopened && !(yield* Ref.get(reopenAvailable))) return yield* refuse("setup_closed");
						if (reopened && party.expectedOrigin !== config.expectedOrigin) return yield* refuse("origin_invalid");
						const state = yield* Ref.get(setup);
						const challenge = yield* takeChallenge(id, "setup");
						if (!state || challenge.setup_generation !== state.generation) return yield* refuse("challenge_invalid");
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
						if (challenge.expires_at <= (yield* Clock.currentTimeMillis)) return yield* refuse("challenge_invalid");
						const credential = verified.registrationInfo.credential;
						const publicKey = Buffer.from(credential.publicKey).toString("base64url");
						const transports = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
							credential.transports ?? [],
						);
						const now = yield* Clock.currentTimeMillis;
						yield* sql`INSERT INTO passkeys (id, public_key, counter, transports, label, created_at, rp_id)
			VALUES (${credential.id}, ${publicKey}, ${credential.counter}, ${transports}, ${reopened ? "Recovery passkey" : "First passkey"}, ${now}, ${party.rpId})`;
						yield* sql`DELETE FROM auth_challenges WHERE ceremony = 'setup'`;
						// Clear before commit so interruption cannot retain the old setup code.
						// A failed commit safely requires a fresh code on the next setup attempt.
						yield* Ref.set(setup, null);
						// Any completed setup uses up REOPEN_SETUP for this process.
						yield* Ref.set(reopenAvailable, false);
						if (reopened)
							yield* events.writeBoot({
								at: now,
								type: "auth.setup_reopened",
								level: "warn",
								actor: humanAgent,
								instance: null,
								generation: 0,
								request_id: null,
								topic: null,
								message_id: null,
								payload: { origin: party.expectedOrigin, rp_id: party.rpId },
							});
						return { credentialId: credential.id };
					}),
				),
			);
		const startLogin = (party: RelyingParty) =>
			mutex.withPermit(
				Effect.gen(function* () {
					if (yield* noPasskeys) return yield* refuse("setup_required");
					if ((yield* passkeyOriginState).stranded) return yield* refuse("passkey_origin_mismatch");
					const options = yield* Effect.tryPromise({
						try: () => generateAuthenticationOptions({ rpID: party.rpId, userVerification: "required" }),
						catch: () => new AuthError({ code: "authentication_failed" }),
					});
					return { id: yield* saveChallenge(options.challenge, "login", null), options };
				}),
			);
		/** A passkey verifies only under the RP ID it was registered with. Login also pins the request's origin;
		 * action proofs accept any allowed origin of that RP ID, since the proof, not the route, names the passkey.
		 * A passkey stored before boot recorded RP IDs is tried under the configured primary RP ID and stamped only
		 * once its signature proves that RP ID, so a mistaken configuration never permanently mislabels it. */
		const verifyAssertion = Effect.fn("Auth.verifyAssertion")(function* (
			id: string,
			response: AuthenticationResponseJSON,
			ceremony: string,
			binding: string | null,
			party?: RelyingParty,
		) {
			const challenge = yield* takeChallenge(id, ceremony);
			if (challenge.setup_generation !== binding) return yield* refuse("challenge_invalid");
			const rows = yield* sql`SELECT id, public_key, counter, rp_id FROM passkeys WHERE id = ${response.id}`;
			const credential = (yield* Schema.decodeUnknownEffect(Schema.Array(passkeyRow))(rows))[0];
			const rpId = credential?.rp_id ?? config.rpId;
			if (!credential || (party && party.rpId !== rpId)) return yield* refuse("authentication_invalid");
			const origins = party
				? [party.expectedOrigin]
				: (yield* allowed).filter((item) => item.rpId === rpId).map((item) => item.expectedOrigin);
			if (!origins.length) return yield* refuse("authentication_invalid");
			const verified = yield* Effect.tryPromise({
				try: () =>
					verifyAuthenticationResponse({
						response,
						expectedChallenge: challenge.challenge,
						expectedOrigin: origins,
						expectedRPID: rpId,
						requireUserVerification: true,
						credential: {
							id: credential.id,
							publicKey: new Uint8Array(Buffer.from(credential.public_key, "base64url")),
							counter: credential.counter,
						},
					}),
				catch: () => new AuthError({ code: "authentication_invalid" }),
			});
			if (!verified.verified) return yield* refuse("authentication_invalid");
			if (challenge.expires_at <= (yield* Clock.currentTimeMillis)) return yield* refuse("challenge_invalid");
			yield* sql`UPDATE passkeys SET counter = ${verified.authenticationInfo.newCounter}, rp_id = ${rpId} WHERE id = ${credential.id}`;
			yield* sql`DELETE FROM auth_challenges WHERE id = ${id}`;
		});
		const finishLogin = (party: RelyingParty) => (id: string, response: AuthenticationResponseJSON) =>
			mutex.withPermit(
				sql.withTransaction(
					lockBootWrite(sql).pipe(
						Effect.andThen(
							Effect.flatMap(passkeyOriginState, (state) =>
								state.stranded ? refuse("passkey_origin_mismatch") : Effect.void,
							),
						),
						Effect.andThen(verifyAssertion(id, response, "login", null, party)),
						Effect.andThen(newSession(party.expectedOrigin)),
					),
				),
			);
		const actions = yield* makeActionAssertions(mutex, noPasskeys, saveChallenge, random, config.rpId);
		const settings = yield* makeSettings(
			(params, proof, session) =>
				verifyAssertion(proof.id, proof.response, "settings.change", canonicalSettings(params, session)),
			mutex,
		);
		const authorizeRestart = (proof: AssertionProof, sessionId: string) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						yield* verifyAssertion(proof.id, proof.response, "boot.restart", restartBinding(sessionId));
						const now = yield* Clock.currentTimeMillis;
						if (!(yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`).length)
							return yield* refuse("session_invalid");
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);
		const passkeys = yield* makePasskeyManagement(
			config,
			(action, binding, proof) => verifyAssertion(proof.id, proof.response, action, binding),
			mutex,
		);
		const origins = yield* makeOriginManagement(
			config,
			(binding, proof) => verifyAssertion(proof.id, proof.response, "origin.remove", binding),
			mutex,
		);
		const codes = yield* makePasskeyCodes(
			config,
			(binding, proof) => verifyAssertion(proof.id, proof.response, "passkey.code", binding),
			newSession,
			mutex,
		);
		const breakLock = yield* makeLockBreak(
			(params: BreakLock, proof: AssertionProof) =>
				verifyAssertion(proof.id, proof.response, "lock.break", canonicalLockBreak(params)),
			mutex,
		);
		const mint = yield* makeTokenMint(
			(params, proof) => verifyAssertion(proof.id, proof.response, "token.mint", canonicalMint(params)),
			mutex,
		);
		const authorizeSourceReset = (seedDigest: string, proof: AssertionProof, sessionId: string) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (!validSeedDigest(seedDigest)) return yield* refuse("invalid_request");
						const liveSession = Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							if (!(yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`).length)
								return yield* refuse("session_invalid");
						});
						yield* liveSession;
						yield* verifyAssertion(proof.id, proof.response, "app.reset", canonicalSourceReset(seedDigest, sessionId));
						yield* liveSession;
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);
		const authorizeDatabaseRestore = yield* makeDatabaseRestoreAuth((params, proof, sessionId, target) => {
			if ("backup" in params)
				return verifyAssertion(proof.id, proof.response, "db.restore", canonicalDatabaseRestore(params, sessionId));
			if (!target) return refuse("invalid_request");
			return verifyAssertion(
				proof.id,
				proof.response,
				"generation.restore",
				canonicalGenerationRestore(params, sessionId, target),
			);
		}, mutex);
		const tokens = yield* makeTokens(
			(params: RevokeFamily, proof: AssertionProof) =>
				verifyAssertion(proof.id, proof.response, "token.revoke", canonicalRevocation(params)),
			mutex,
		);
		const enrollment = yield* makeEnrollment(
			(params: EnrollmentDecision, proof: AssertionProof) =>
				verifyAssertion(proof.id, proof.response, "enrollment.decide", canonicalDecision(params)),
			mutex,
		);

		const authenticateSession = Effect.fn("Auth.authenticateSession")(function* (token: string) {
			const digest = yield* hash(token);
			const now = yield* Clock.currentTimeMillis;
			const rows = yield* on(sql, {
				sqlite: () =>
					sql`UPDATE sessions SET last_seen_at = ${now} WHERE hash = ${digest} AND expires_at > ${now} RETURNING id, expires_at`,
				pg: () =>
					sql`UPDATE sessions SET last_seen_at = ${now} WHERE hash = ${digest} AND expires_at > ${now} RETURNING id, expires_at`,
				mysql: () =>
					sql.withTransaction(
						Effect.gen(function* () {
							yield* sql`UPDATE sessions SET last_seen_at = ${now} WHERE hash = ${digest} AND expires_at > ${now}`;
							return yield* sql`SELECT id,expires_at FROM sessions WHERE hash=${digest} AND expires_at>${now} FOR UPDATE`;
						}),
					),
			});
			const session = (yield* Schema.decodeUnknownEffect(Schema.Array(sessionRow))(rows))[0];
			if (!session) return yield* refuse("session_invalid");
			return { id: session.id, expiresAt: session.expires_at };
		});
		const logout = Effect.fn("Auth.logout")(function* (token: string) {
			const digest = yield* hash(token);
			yield* sql.withTransaction(
				lockBootWrite(sql).pipe(Effect.andThen(sql`DELETE FROM sessions WHERE hash = ${digest}`)),
			);
		});
		/** Ceremonies whose browser options or registration are bound to one origin's RP ID. */
		const at = (party: RelyingParty) => ({
			...actions(party),
			startSetup: startSetup(party),
			finishSetup: finishSetup(party),
			startLogin: startLogin(party),
			finishLogin: finishLogin(party),
			startPasskeyRegistration: (label: string, sessionId: string) =>
				passkeys.startPasskeyRegistration(label, sessionId, party),
			finishPasskeyRegistration: (
				params: Parameters<typeof passkeys.finishPasskeyRegistration>[0],
				proof: AssertionProof,
				sessionId: string,
			) => passkeys.finishPasskeyRegistration(params, proof, sessionId, party),
			removeOrigin: (params: RemoveOrigin, proof: AssertionProof, sessionId: string) =>
				origins.removeOrigin(params, proof, sessionId, party),
		});
		const accounts = yield* makeAccountQueries;
		return {
			...accounts,
			...settings,
			...enrollment,
			...tokens,
			listPasskeys: passkeys.listPasskeys,
			deletePasskey: passkeys.deletePasskey,
			listOrigins: origins.listOrigins,
			...codes,
			...mint,
			authorizeRestart,
			authorizeSourceReset,
			authorizeDatabaseRestore,
			breakLock,
			relyingParty,
			// HTTP routes use at() with the request's origin; these direct members use the primary origin.
			...at({ rpId: config.rpId, expectedOrigin: config.expectedOrigin }),
			at,
			setupOpen: mutex.withPermit(Effect.map(setupState, (state) => state !== null)),
			setupRequired: noPasskeys,
			passkeyOriginState,
			authenticateSession,
			logout,
		};
	});

export class Auth extends Context.Service<Auth, Effect.Success<ReturnType<typeof makeAuth>>>()("comms/Auth") {}
export const layer = (config: AuthConfig) => Layer.effect(Auth, makeAuth(config));
