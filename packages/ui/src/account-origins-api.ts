import { assertionHeader } from "@comms/protocol/headers";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { accountPost, accountRequest, unreadable } from "./account-api.ts";
import { confirmAccountAction } from "./account-passkeys.ts";

const Origins = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			origin: Schema.String,
			rp_id: Schema.String,
			source: Schema.Literals(["config", "runtime", "code"]),
			status: Schema.Literals(["active", "pending"]),
			passkeys: Schema.Int,
			removable: Schema.Boolean,
		}),
	),
});
const PasskeyCode = Schema.Struct({
	code: Schema.String,
	origin: Schema.NullOr(Schema.String),
	expires_at: Schema.Int,
});
export type OriginList = typeof Origins.Type;
export type PasskeyCode = typeof PasskeyCode.Type;

export const getOrigins = Effect.suspend(() =>
	accountRequest(HttpClientRequest.get(new URL("/_boot/auth/origins", window.location.origin).href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Origins)),
		Effect.catchTag("SchemaError", () => unreadable),
	),
);
/** The code is shown once; the board keeps only its hash. */
export const createPasskeyCode = (origin: string) =>
	Effect.gen(function* () {
		const params = origin ? { origin } : {};
		const proof = yield* confirmAccountAction("passkey.code", params);
		return yield* accountPost("/_boot/auth/passkey-code", params, proof).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(PasskeyCode)),
			Effect.catchTag("SchemaError", () => unreadable),
		);
	});
export const revokePasskeyCode = accountRequest(
	HttpClientRequest.delete(new URL("/_boot/auth/passkey-code", window.location.origin).href).pipe(
		HttpClientRequest.bodyJsonUnsafe({}),
	),
).pipe(Effect.asVoid);
export const removeOrigin = (origin: string) =>
	Effect.gen(function* () {
		const proof = yield* confirmAccountAction("origin.remove", { origin });
		yield* accountRequest(
			HttpClientRequest.delete(new URL("/_boot/auth/origins", window.location.origin).href).pipe(
				HttpClientRequest.bodyJsonUnsafe({ origin }),
				HttpClientRequest.setHeader(assertionHeader, proof),
			),
		);
	});
