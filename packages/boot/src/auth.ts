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
import { makeDatabaseRestoreAuth } from "./database-restore-auth.ts";
import { canonicalDatabaseRestore, validDatabaseRestore, type DatabaseRestore } from "./database-restore-schema.ts";
import { makeTokenMint } from "./token-mint.ts";
import { canonicalMint, validMint, type MintBinding } from "./token-mint-schema.ts";
import { makeTokens } from "./tokens.ts";
import { makeLockBreak } from "./lock-break.ts";
import { canonicalLockBreak, validLockId, type BreakLock } from "./lock-break-schema.ts";
import { canonicalRevocation, validFamily, type RevokeFamily } from "./refresh-schema.ts";
import { canonicalDecision, validDecision, type EnrollmentDecision } from "./enrollment-schema.ts";

export interface AuthConfig {
	readonly rpId: string;
	readonly expectedOrigin: string;
}

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
	code: Schema.String,
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
const denied = (code: string) => Effect.fail(new AuthError({ code }));
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
		const random = Effect.map(crypto.randomBytes(32), (bytes) => Buffer.from(bytes).toString("base64url"));
		const hash = (value: string) =>
			crypto
				.digest("SHA-256", new TextEncoder().encode(value))
				.pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
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
				return yield* denied("challenge_invalid");
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
					if (!state) return yield* denied("setup_closed");
					if (!same(code, state.code)) {
						if (state.failures + 1 >= 3) yield* rotateSetup;
						else yield* Ref.set(setup, { ...state, failures: state.failures + 1 });
						return yield* denied("setup_code_invalid");
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
						if (!(yield* noPasskeys)) return yield* denied("setup_closed");
						const state = yield* Ref.get(setup);
						const challenge = yield* takeChallenge(id, "setup");
						if (!state || challenge.setup_generation !== state.generation) return yield* denied("challenge_invalid");
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
						if (!verified.verified) return yield* denied("registration_invalid");
						if (challenge.expires_at <= (yield* Clock.currentTimeMillis)) return yield* denied("challenge_invalid");
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
				if (yield* noPasskeys) return yield* denied("setup_required");
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
			if (challenge.setup_generation !== binding) return yield* denied("challenge_invalid");
			const rows = yield* sql`SELECT id, public_key, counter FROM passkeys WHERE id = ${response.id}`;
			const credential = (yield* Schema.decodeUnknownEffect(Schema.Array(passkeyRow))(rows))[0];
			if (!credential) return yield* denied("authentication_invalid");
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
			if (!verified.verified) return yield* denied("authentication_invalid");
			if (challenge.expires_at <= (yield* Clock.currentTimeMillis)) return yield* denied("challenge_invalid");
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
				| "db.restore",
			binding: string,
		) =>
			mutex.withPermit(
				Effect.gen(function* () {
					if (yield* noPasskeys) return yield* denied("setup_required");
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
		const startEnrollmentAssertion = (params: EnrollmentDecision) =>
			validDecision(params)
				? startActionAssertion("enrollment.decide", canonicalDecision(params))
				: denied("invalid_request");
		const startRevocationAssertion = (params: RevokeFamily) =>
			validFamily(params.family)
				? startActionAssertion("token.revoke", canonicalRevocation(params))
				: denied("invalid_request");
		const startLockBreakAssertion = (params: BreakLock) =>
			validLockId(params.id)
				? startActionAssertion("lock.break", canonicalLockBreak(params))
				: denied("invalid_request");
		const startPasskeyAddAssertion = (params: AddPasskey, sessionId: string) =>
			validPasskeyLabel(params.label) && validPasskeyId(params.registration)
				? canonicalPasskeyAdd(params, sessionId).pipe(
						Effect.flatMap((binding) => startActionAssertion("passkey.add", binding)),
					)
				: denied("invalid_request");
		const startPasskeyDeleteAssertion = (params: DeletePasskey, sessionId: string) =>
			validPasskeyId(params.id)
				? startActionAssertion("passkey.delete", canonicalPasskeyDelete(params, sessionId))
				: denied("invalid_request");
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
			validMint(params) ? startActionAssertion("token.mint", canonicalMint(params)) : denied("invalid_request");
		const mint = yield* makeTokenMint(
			(params, proof) => verifyAssertion(proof.id, proof.response, "token.mint", canonicalMint(params)),
			mutex,
		);
		const startDatabaseRestoreAssertion = (params: DatabaseRestore, sessionId: string) =>
			validDatabaseRestore(params)
				? startActionAssertion("db.restore", canonicalDatabaseRestore(params, sessionId))
				: denied("invalid_request");
		const authorizeDatabaseRestore = yield* makeDatabaseRestoreAuth(
			(params, proof, sessionId) =>
				verifyAssertion(proof.id, proof.response, "db.restore", canonicalDatabaseRestore(params, sessionId)),
			mutex,
		);
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
			if (!session) return yield* denied("session_invalid");
			return { id: session.id, expiresAt: session.expires_at };
		});
		const logout = Effect.fn("Auth.logout")(function* (token: string) {
			const digest = yield* hash(token);
			yield* sql`DELETE FROM sessions WHERE hash = ${digest}`;
		});
		const accounts = yield* makeAccountQueries;
		return {
			...accounts,
			...enrollment,
			...tokens,
			...passkeys,
			startPasskeyAddAssertion,
			startPasskeyDeleteAssertion,
			...mint,
			startMintAssertion,
			startDatabaseRestoreAssertion,
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
