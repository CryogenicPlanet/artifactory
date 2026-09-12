import { makeSettings } from "./settings.ts";
import { SettingsChange, canonicalSettings } from "./settings-schema.ts";
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
import {
	canonicalPasskeyAdd,
	canonicalPasskeyDelete,
	validPasskeyLabel,
	validPasskeyId,
	type AddPasskey,
	type DeletePasskey,
} from "./passkey-management-schema.ts";
import { makeDatabaseRestoreAuth, resolveRestoreTarget } from "./database-restore-auth.ts";
import {
	canonicalDatabaseRestore,
	canonicalGenerationRestore,
	validDatabaseRestore,
	validRestoreSelection,
	type DatabaseRestore,
	type GenerationRestore,
} from "./database-restore-schema.ts";
import { canonicalSourceReset, validSeedDigest } from "./source-reset-schema.ts";
import { makeTokenMint } from "./token-mint.ts";
import { canonicalMint, validMint, type MintBinding } from "./token-mint-schema.ts";
import { makeTokens } from "./tokens.ts";
import { makeLockBreak, canonicalLockBreak, validLockId, type BreakLock } from "./lock-break.ts";
import { canonicalRevocation, validFamily, type RevokeFamily } from "./refresh-schema.ts";
import { canonicalDecision, validDecision, type EnrollmentDecision } from "./enrollment-schema.ts";

export interface AuthConfig {
	readonly rpId: string;
	readonly expectedOrigin: string;
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
		"origin_invalid",
		"passkey_exists",
		"passkey_not_found",
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
const passkeyRow = Schema.Struct({ id: Schema.String, public_key: Schema.String, counter: Schema.Finite });
const sessionRow = Schema.Struct({ id: Schema.String, expires_at: Schema.Finite });
const same = (left: string, right: string) => {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
};

/** Boot-owned passkeys and sessions. No app code or external credential issuer is involved. */
const makeAuth = (config: AuthConfig) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const bootConsole = yield* Console.Console;
		const mutex = yield* Semaphore.make(1);
		const setup = yield* Ref.make<{
			readonly code: string;
			readonly generation: string;
			readonly failures: number;
		} | null>(null);
		const { hash, random } = authSecrets(crypto);
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
			yield* Effect.sync(() => bootConsole.log(`comms: /setup is open, code ${code}`));
			return { code, generation, failures: 0 };
		});
		const setupState = Effect.gen(function* () {
			if (!(yield* noPasskeys)) {
				yield* Ref.set(setup, null);
				return null;
			}
			return (yield* Ref.get(setup)) ?? (yield* rotateSetup);
		});
		// Every boot invalidates setup ceremonies created under an earlier stdout code.
		yield* sql`DELETE FROM auth_challenges WHERE ceremony = 'setup'`;
		yield* setupState;

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
		const newSession = Effect.gen(function* () {
			const token = yield* random;
			const id = yield* random;
			const now = yield* Clock.currentTimeMillis;
			const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
			const digest = yield* hash(token);
			yield* sql`INSERT INTO sessions (id, hash, created_at, expires_at, last_seen_at) VALUES (${id}, ${digest}, ${now}, ${expiresAt}, ${now})`;
			return { token, id, expiresAt };
		});
		const startSetup = (code: string) =>
			mutex.withPermit(
				Effect.gen(function* () {
					const state = yield* setupState;
					if (!state) return yield* refuse("setup_closed");
					if (!same(code, state.code)) {
						if (state.failures + 1 >= 3) yield* rotateSetup;
						else yield* Ref.set(setup, { ...state, failures: state.failures + 1 });
						return yield* refuse("setup_code_invalid");
					}
					const options = yield* Effect.tryPromise({
						try: () =>
							generateRegistrationOptions({
								rpName: "comms",
								rpID: config.rpId,
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
		const finishSetup = (id: string, response: RegistrationResponseJSON) =>
			mutex.withPermit(
				sql.withTransaction(
					Effect.gen(function* () {
						if (!(yield* noPasskeys)) return yield* refuse("setup_closed");
						const state = yield* Ref.get(setup);
						const challenge = yield* takeChallenge(id, "setup");
						if (!state || challenge.setup_generation !== state.generation) return yield* refuse("challenge_invalid");
						const verified = yield* Effect.tryPromise({
							try: () =>
								verifyRegistrationResponse({
									response,
									expectedChallenge: challenge.challenge,
									expectedOrigin: config.expectedOrigin,
									expectedRPID: config.rpId,
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
						yield* sql`INSERT INTO passkeys (id, public_key, counter, transports, label, created_at)
			VALUES (${credential.id}, ${publicKey}, ${credential.counter}, ${transports}, 'First passkey', ${now})`;
						yield* sql`DELETE FROM auth_challenges WHERE ceremony = 'setup'`;
						// Clear before commit so interruption cannot retain the old setup code.
						// A failed commit safely requires a fresh code on the next setup attempt.
						yield* Ref.set(setup, null);
						return { credentialId: credential.id };
					}),
				),
			);
		const startLogin = mutex.withPermit(
			Effect.gen(function* () {
				if (yield* noPasskeys) return yield* refuse("setup_required");
				const options = yield* Effect.tryPromise({
					try: () => generateAuthenticationOptions({ rpID: config.rpId, userVerification: "required" }),
					catch: () => new AuthError({ code: "authentication_failed" }),
				});
				return { id: yield* saveChallenge(options.challenge, "login", null), options };
			}),
		);
		const verifyAssertion = Effect.fn("Auth.verifyAssertion")(function* (
			id: string,
			response: AuthenticationResponseJSON,
			ceremony: string,
			binding: string | null,
		) {
			const challenge = yield* takeChallenge(id, ceremony);
			if (challenge.setup_generation !== binding) return yield* refuse("challenge_invalid");
			const rows = yield* sql`SELECT id, public_key, counter FROM passkeys WHERE id = ${response.id}`;
			const credential = (yield* Schema.decodeUnknownEffect(Schema.Array(passkeyRow))(rows))[0];
			if (!credential) return yield* refuse("authentication_invalid");
			const verified = yield* Effect.tryPromise({
				try: () =>
					verifyAuthenticationResponse({
						response,
						expectedChallenge: challenge.challenge,
						expectedOrigin: config.expectedOrigin,
						expectedRPID: config.rpId,
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
			yield* sql`UPDATE passkeys SET counter = ${verified.authenticationInfo.newCounter} WHERE id = ${credential.id}`;
			yield* sql`DELETE FROM auth_challenges WHERE id = ${id}`;
		});
		const finishLogin = (id: string, response: AuthenticationResponseJSON) =>
			mutex.withPermit(
				sql.withTransaction(verifyAssertion(id, response, "login", null).pipe(Effect.andThen(newSession))),
			);
		const startActionAssertion = (
			action:
				| "enrollment.decide"
				| "token.revoke"
				| "lock.break"
				| "passkey.add"
				| "passkey.delete"
				| "token.mint"
				| "db.restore"
				| "generation.restore"
				| "boot.restart"
				| "app.reset"
				| "settings.change",
			binding: string,
		) =>
			mutex.withPermit(
				Effect.gen(function* () {
					if (yield* noPasskeys) return yield* refuse("setup_required");
					const nonce = yield* random;
					const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(`${action}${binding}${nonce}`));
					const challenge = Buffer.from(bytes).toString("base64url");
					// A newly created, not-yet-authorized discoverable credential must not be offered for this proof.
					const allowed =
						action === "passkey.add"
							? yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))(
									yield* sql`SELECT id FROM passkeys`,
								)
							: undefined;
					const options = yield* Effect.tryPromise({
						try: () =>
							generateAuthenticationOptions({
								rpID: config.rpId,
								userVerification: "required",
								challenge,
								...(allowed ? { allowCredentials: allowed.map(({ id }) => ({ id })) } : {}),
							}),
						catch: () => new AuthError({ code: "authentication_failed" }),
					});
					return { id: yield* saveChallenge(options.challenge, action, binding), options };
				}),
			);
		const settings = yield* makeSettings(
			(params, proof, session) =>
				verifyAssertion(proof.id, proof.response, "settings.change", canonicalSettings(params, session)),
			mutex,
		);
		const startSettingsAssertion = (params: SettingsChange, session: string) =>
			Schema.is(SettingsChange)(params) && params.patch.event_retention === undefined
				? startActionAssertion("settings.change", canonicalSettings(params, session))
				: refuse("invalid_request");
		const restartBinding = (sessionId: string) => JSON.stringify({ session: sessionId });
		const startRestartAssertion = (sessionId: string) =>
			startActionAssertion("boot.restart", restartBinding(sessionId));
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
		const startEnrollmentAssertion = (params: EnrollmentDecision) =>
			validDecision(params)
				? startActionAssertion("enrollment.decide", canonicalDecision(params))
				: refuse("invalid_request");
		const startRevocationAssertion = (params: RevokeFamily) =>
			validFamily(params.family)
				? startActionAssertion("token.revoke", canonicalRevocation(params))
				: refuse("invalid_request");
		const startLockBreakAssertion = (params: BreakLock) =>
			validLockId(params.id)
				? startActionAssertion("lock.break", canonicalLockBreak(params))
				: refuse("invalid_request");
		const startPasskeyAddAssertion = (params: AddPasskey, sessionId: string) =>
			validPasskeyLabel(params.label) && validPasskeyId(params.registration)
				? canonicalPasskeyAdd(params, sessionId).pipe(
						Effect.flatMap((binding) => startActionAssertion("passkey.add", binding)),
					)
				: refuse("invalid_request");
		const startPasskeyDeleteAssertion = (params: DeletePasskey, sessionId: string) =>
			validPasskeyId(params.id)
				? startActionAssertion("passkey.delete", canonicalPasskeyDelete(params, sessionId))
				: refuse("invalid_request");
		const passkeys = yield* makePasskeyManagement(
			config,
			(action, binding, proof) => verifyAssertion(proof.id, proof.response, action, binding),
			mutex,
		);
		const breakLock = yield* makeLockBreak(
			(params: BreakLock, proof: AssertionProof) =>
				verifyAssertion(proof.id, proof.response, "lock.break", canonicalLockBreak(params)),
			mutex,
		);
		const startMintAssertion = (params: MintBinding) =>
			validMint(params) ? startActionAssertion("token.mint", canonicalMint(params)) : refuse("invalid_request");
		const mint = yield* makeTokenMint(
			(params, proof) => verifyAssertion(proof.id, proof.response, "token.mint", canonicalMint(params)),
			mutex,
		);
		const startDatabaseRestoreAssertion = (params: DatabaseRestore, sessionId: string) =>
			validDatabaseRestore(params)
				? startActionAssertion("db.restore", canonicalDatabaseRestore(params, sessionId))
				: refuse("invalid_request");
		const startGenerationRestoreAssertion = (params: GenerationRestore, sessionId: string) =>
			Effect.gen(function* () {
				if (!validRestoreSelection(params)) return yield* refuse("invalid_request");
				const target = yield* resolveRestoreTarget(params).pipe(Effect.provideService(SqlClient.SqlClient, sql));
				return yield* startActionAssertion("generation.restore", canonicalGenerationRestore(params, sessionId, target));
			});
		const startSourceResetAssertion = (seedDigest: string, sessionId: string) =>
			validSeedDigest(seedDigest)
				? startActionAssertion("app.reset", canonicalSourceReset(seedDigest, sessionId))
				: refuse("invalid_request");
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
			const rows =
				yield* sql`UPDATE sessions SET last_seen_at = ${now} WHERE hash = ${digest} AND expires_at > ${now} RETURNING id, expires_at`;
			const session = (yield* Schema.decodeUnknownEffect(Schema.Array(sessionRow))(rows))[0];
			if (!session) return yield* refuse("session_invalid");
			return { id: session.id, expiresAt: session.expires_at };
		});
		const logout = Effect.fn("Auth.logout")(function* (token: string) {
			const digest = yield* hash(token);
			yield* sql`DELETE FROM sessions WHERE hash = ${digest}`;
		});
		const accounts = yield* makeAccountQueries;
		return {
			...accounts,
			...settings,
			startSettingsAssertion,
			...enrollment,
			...tokens,
			...passkeys,
			startPasskeyAddAssertion,
			startPasskeyDeleteAssertion,
			...mint,
			startMintAssertion,
			startRestartAssertion,
			authorizeRestart,
			startDatabaseRestoreAssertion,
			startGenerationRestoreAssertion,
			startSourceResetAssertion,
			authorizeSourceReset,
			authorizeDatabaseRestore,
			startLockBreakAssertion,
			breakLock,
			startRevocationAssertion,
			startEnrollmentAssertion,
			setupOpen: mutex.withPermit(Effect.map(setupState, (state) => state !== null)),
			startSetup,
			finishSetup,
			startLogin,
			finishLogin,
			authenticateSession,
			logout,
		};
	});

export class Auth extends Context.Service<Auth, Effect.Success<ReturnType<typeof makeAuth>>>()("comms/Auth") {}
export const layer = (config: AuthConfig) => Layer.effect(Auth, makeAuth(config));
