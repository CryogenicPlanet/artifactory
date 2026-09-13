// Fixed-order arrays are deliberately serialized for cryptographic bindings.
/* oxlint-disable effecttsgo/prefer-schema-over-json */
import { Crypto, Effect, Schema } from "effect";

/** Generate a one-time add-passkey code, optionally bound to a new origin that redemption activates. */
export const PasskeyCodeParams = Schema.Struct({ origin: Schema.optionalKey(Schema.String) });
export type PasskeyCodeParams = typeof PasskeyCodeParams.Type;
export const RemoveOrigin = Schema.Struct({ origin: Schema.String });
export type RemoveOrigin = typeof RemoveOrigin.Type;

/** Challenge bindings are stored in a 128-character column, so an origin is bound by digest. */
const bind = (action: string, sessionId: string, origin: string | null) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const bytes = new TextEncoder().encode(JSON.stringify([action, origin]));
		const digest = Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex");
		return JSON.stringify([sessionId, digest]);
	});

export const canonicalPasskeyCode = (params: PasskeyCodeParams, sessionId: string) =>
	bind("passkey.code", sessionId, params.origin ?? null);
export const canonicalOriginRemove = (params: RemoveOrigin, sessionId: string) =>
	bind("origin.remove", sessionId, params.origin);
