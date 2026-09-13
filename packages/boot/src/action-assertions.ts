import { refuse } from "./auth-primitives.ts";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { Crypto, Effect, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError } from "./auth.ts";
import type { RelyingParty } from "./auth-origins.ts";
import { SettingsChange, canonicalSettings } from "./settings-schema.ts";
import {
	canonicalPasskeyAdd,
	canonicalPasskeyDelete,
	validPasskeyLabel,
	validPasskeyId,
	type AddPasskey,
	type DeletePasskey,
} from "./passkey-management-schema.ts";
import {
	canonicalOriginRemove,
	canonicalPasskeyCode,
	type PasskeyCodeParams,
	type RemoveOrigin,
} from "./passkey-code-schema.ts";
import { resolveRestoreTarget } from "./database-restore-auth.ts";
import {
	canonicalDatabaseRestore,
	canonicalGenerationRestore,
	validDatabaseRestore,
	validRestoreSelection,
	type DatabaseRestore,
	type GenerationRestore,
} from "./database-restore-schema.ts";
import { canonicalSourceReset, validSeedDigest } from "./source-reset-schema.ts";
import { canonicalMint, validMint, type MintBinding } from "./token-mint-schema.ts";
import { canonicalLockBreak, validLockId, type BreakLock } from "./lock-break.ts";
import { canonicalRevocation, validFamily, type RevokeFamily } from "./refresh-schema.ts";
import { canonicalDecision, validDecision, type EnrollmentDecision } from "./enrollment-schema.ts";

export type AssertionAction =
	| "enrollment.decide"
	| "token.revoke"
	| "lock.break"
	| "passkey.add"
	| "passkey.delete"
	| "passkey.code"
	| "origin.remove"
	| "token.mint"
	| "db.restore"
	| "generation.restore"
	| "boot.restart"
	| "app.reset"
	| "settings.change";

export const restartBinding = (sessionId: string) => JSON.stringify({ session: sessionId });

/** Action-bound challenges for one relying party: the browser only offers passkeys bound to its own RP ID. */
export const makeActionAssertions = <E, R, RandomError>(
	mutex: Semaphore.Semaphore,
	noPasskeys: Effect.Effect<boolean, E, R>,
	saveChallenge: (challenge: string, ceremony: string, binding: string) => Effect.Effect<string, E, R>,
	random: Effect.Effect<string, RandomError>,
	// Passkeys without a stored RP ID are treated as the primary RP ID's.
	primaryRpId: string,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		return (party: RelyingParty) => {
			const start = (action: AssertionAction, binding: string) =>
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
										yield* sql`SELECT id FROM passkeys WHERE COALESCE(rp_id, ${primaryRpId})=${party.rpId}`,
									)
								: undefined;
						const options = yield* Effect.tryPromise({
							try: () =>
								generateAuthenticationOptions({
									rpID: party.rpId,
									userVerification: "required",
									challenge,
									...(allowed ? { allowCredentials: allowed.map(({ id }) => ({ id })) } : {}),
								}),
							catch: () => new AuthError({ code: "authentication_failed" }),
						});
						return { id: yield* saveChallenge(options.challenge, action, binding), options };
					}),
				);
			return {
				startSettingsAssertion: (params: SettingsChange, session: string) =>
					Schema.is(SettingsChange)(params) && params.patch.event_retention === undefined
						? start("settings.change", canonicalSettings(params, session))
						: refuse("invalid_request"),
				startRestartAssertion: (sessionId: string) => start("boot.restart", restartBinding(sessionId)),
				startEnrollmentAssertion: (params: EnrollmentDecision) =>
					validDecision(params) ? start("enrollment.decide", canonicalDecision(params)) : refuse("invalid_request"),
				startRevocationAssertion: (params: RevokeFamily) =>
					validFamily(params.family) ? start("token.revoke", canonicalRevocation(params)) : refuse("invalid_request"),
				startLockBreakAssertion: (params: BreakLock) =>
					validLockId(params.id) ? start("lock.break", canonicalLockBreak(params)) : refuse("invalid_request"),
				startPasskeyAddAssertion: (params: AddPasskey, sessionId: string) =>
					validPasskeyLabel(params.label) && validPasskeyId(params.registration)
						? canonicalPasskeyAdd(params, sessionId).pipe(Effect.flatMap((binding) => start("passkey.add", binding)))
						: refuse("invalid_request"),
				startPasskeyDeleteAssertion: (params: DeletePasskey, sessionId: string) =>
					validPasskeyId(params.id)
						? start("passkey.delete", canonicalPasskeyDelete(params, sessionId))
						: refuse("invalid_request"),
				startPasskeyCodeAssertion: (params: PasskeyCodeParams, sessionId: string) =>
					canonicalPasskeyCode(params, sessionId).pipe(Effect.flatMap((binding) => start("passkey.code", binding))),
				startOriginRemoveAssertion: (params: RemoveOrigin, sessionId: string) =>
					canonicalOriginRemove(params, sessionId).pipe(Effect.flatMap((binding) => start("origin.remove", binding))),
				startMintAssertion: (params: MintBinding) =>
					validMint(params) ? start("token.mint", canonicalMint(params)) : refuse("invalid_request"),
				startDatabaseRestoreAssertion: (params: DatabaseRestore, sessionId: string) =>
					validDatabaseRestore(params)
						? start("db.restore", canonicalDatabaseRestore(params, sessionId))
						: refuse("invalid_request"),
				startGenerationRestoreAssertion: (params: GenerationRestore, sessionId: string) =>
					Effect.gen(function* () {
						if (!validRestoreSelection(params)) return yield* refuse("invalid_request");
						const target = yield* resolveRestoreTarget(params).pipe(Effect.provideService(SqlClient.SqlClient, sql));
						return yield* start("generation.restore", canonicalGenerationRestore(params, sessionId, target));
					}),
				startSourceResetAssertion: (seedDigest: string, sessionId: string) =>
					validSeedDigest(seedDigest)
						? start("app.reset", canonicalSourceReset(seedDigest, sessionId))
						: refuse("invalid_request"),
			};
		};
	});
