import { lockBootWrite } from "./boot-write-lock.ts";
import { committed, captureRefusal } from "./auth-primitives.ts";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import { Clock, Crypto, Effect, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError, type AuthConfig } from "./auth.ts";
import { configuredParties, type RelyingParty } from "./auth-origins.ts";
import type { AssertionProof } from "./enrollment.ts";
import {
	canonicalPasskeyAdd,
	canonicalPasskeyDelete,
	registrationBinding,
	validPasskeyId,
	validPasskeyLabel,
	type AddPasskey,
	type DeletePasskey,
} from "./passkey-management-schema.ts";

const item = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	created_at: Schema.Finite,
	rp_id: Schema.NullOr(Schema.String),
});
const challengeRow = Schema.Struct({
	challenge: Schema.String,
	setup_generation: Schema.NullOr(Schema.String),
	expires_at: Schema.Finite,
});

/** Composes with Auth's single mutex and boot transaction; registration state survives restart. */
export const makePasskeyManagement = <E, R>(
	config: AuthConfig,
	verify: (
		action: "passkey.add" | "passkey.delete",
		binding: string,
		proof: AssertionProof,
	) => Effect.Effect<void, E, R>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const liveSession = (sessionId: string) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				const rows = yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`;
				if (!rows.length) return yield* new AuthError({ code: "session_invalid" });
			});
		// A configured origin's RP ID must keep a passkey: its origin always answers, and without one no
		// login, code or setup gets the human back in. A NULL rp_id counts as the primary RP ID's.
		const protectedRpIds = configuredParties(config).map((party) => party.rpId);
		const effective = (key: { readonly rp_id: string | null }) => key.rp_id ?? config.rpId;
		const deletable = (
			keys: ReadonlyArray<{ readonly rp_id: string | null }>,
			key: { readonly rp_id: string | null },
		) =>
			keys.length > 1 &&
			(!protectedRpIds.includes(effective(key)) ||
				keys.filter((other) => effective(other) === effective(key)).length > 1);
		const listPasskeys = (sessionId: string) =>
			mutex.withPermit(
				Effect.gen(function* () {
					yield* liveSession(sessionId);
					const rows = yield* sql`SELECT id, label, created_at, rp_id FROM passkeys ORDER BY created_at, id`;
					const items = yield* Schema.decodeUnknownEffect(Schema.Array(item))(rows);
					return {
						items: items.map((key) => ({ ...key, can_delete: deletable(items, key) })),
						can_delete: items.length > 1,
					};
				}),
			);
		const startPasskeyRegistration = (label: string, sessionId: string, party: RelyingParty) =>
			mutex.withPermit(
				sql.withTransaction(
					Effect.gen(function* () {
						yield* lockBootWrite(sql);
						if (!validPasskeyLabel(label)) return yield* new AuthError({ code: "invalid_request" });
						yield* liveSession(sessionId);
						const credentials = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))(
							yield* sql`SELECT id FROM passkeys`,
						);
						if (!credentials.length) return yield* new AuthError({ code: "setup_required" });
						const options = yield* Effect.tryPromise({
							try: () =>
								generateRegistrationOptions({
									rpName: "chirp",
									rpID: party.rpId,
									userName: "human",
									userID: new TextEncoder().encode("comms-human"),
									attestationType: "none",
									authenticatorSelection: { residentKey: "required", userVerification: "required" },
									excludeCredentials: credentials.map(({ id }) => ({ id })),
								}),
							catch: () => new AuthError({ code: "registration_failed" }),
						});
						yield* liveSession(sessionId);
						const id = Buffer.from(yield* crypto.randomBytes(32)).toString("base64url");
						const now = yield* Clock.currentTimeMillis;
						const binding = registrationBinding(sessionId, label);
						yield* sql`DELETE FROM auth_challenges WHERE expires_at<=${now}`;
						yield* sql`INSERT INTO auth_challenges (id,challenge,ceremony,setup_generation,expires_at)
			VALUES (${id},${options.challenge},'passkey.register',${binding},${now + 120_000})`;
						return { id, options };
					}),
				),
			);
		const finishPasskeyRegistration = (
			params: AddPasskey,
			proof: AssertionProof,
			sessionId: string,
			party: RelyingParty,
		) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (!validPasskeyLabel(params.label) || !validPasskeyId(params.registration))
							return yield* new AuthError({ code: "invalid_request" });
						yield* verify("passkey.add", yield* canonicalPasskeyAdd(params, sessionId), proof);
						yield* liveSession(sessionId);
						const rows = yield* sql`SELECT challenge,setup_generation,expires_at FROM auth_challenges
				WHERE id=${params.registration} AND ceremony='passkey.register'`;
						const challenge = (yield* Schema.decodeUnknownEffect(Schema.Array(challengeRow))(rows))[0];
						if (
							!challenge ||
							challenge.setup_generation !== registrationBinding(sessionId, params.label) ||
							challenge.expires_at <= (yield* Clock.currentTimeMillis)
						)
							return yield* new AuthError({ code: "challenge_invalid" });
						// The authenticator signs the RP ID hash, so a ceremony started on another origin fails here.
						const result = yield* Effect.tryPromise({
							try: () =>
								verifyRegistrationResponse({
									response: params.response,
									expectedChallenge: challenge.challenge,
									expectedOrigin: party.expectedOrigin,
									expectedRPID: party.rpId,
									requireUserVerification: true,
								}),
							catch: () => new AuthError({ code: "registration_invalid" }),
						});
						if (!result.verified) return yield* new AuthError({ code: "registration_invalid" });
						yield* liveSession(sessionId);
						const now = yield* Clock.currentTimeMillis;
						if (challenge.expires_at <= now) return yield* new AuthError({ code: "challenge_invalid" });
						const credential = result.registrationInfo.credential;
						if ((yield* sql`SELECT id FROM passkeys WHERE id=${credential.id}`).length)
							return yield* new AuthError({ code: "passkey_exists" });
						const publicKey = Buffer.from(credential.publicKey).toString("base64url");
						const transports = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
							credential.transports ?? [],
						);
						yield* sql`INSERT INTO passkeys (id,public_key,counter,transports,label,created_at,rp_id)
				VALUES (${credential.id},${publicKey},${credential.counter},${transports},${params.label},${now},${party.rpId})`;
						yield* sql`DELETE FROM auth_challenges WHERE id=${params.registration}`;
						return { credentialId: credential.id };
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);
		const deletePasskey = (params: DeletePasskey, proof: AssertionProof, sessionId: string) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (!validPasskeyId(params.id)) return yield* new AuthError({ code: "invalid_request" });
						yield* verify("passkey.delete", canonicalPasskeyDelete(params, sessionId), proof);
						yield* liveSession(sessionId);
						const credentials = yield* Schema.decodeUnknownEffect(
							Schema.Array(Schema.Struct({ id: Schema.String, rp_id: Schema.NullOr(Schema.String) })),
						)(yield* sql`SELECT id, rp_id FROM passkeys`);
						const target = credentials.find((row) => row.id === params.id);
						if (!target) return yield* new AuthError({ code: "passkey_not_found" });
						if (credentials.length <= 1) return yield* new AuthError({ code: "last_passkey" });
						if (!deletable(credentials, target)) return yield* new AuthError({ code: "origin_last_passkey" });
						yield* sql`DELETE FROM passkeys WHERE id=${params.id}`;
						return { deleted: params.id };
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);
		return { listPasskeys, startPasskeyRegistration, finishPasskeyRegistration, deletePasskey };
	});
