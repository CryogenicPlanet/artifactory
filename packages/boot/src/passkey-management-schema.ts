// Fixed-order arrays are deliberately serialized for cryptographic bindings.
/* oxlint-disable effecttsgo/prefer-schema-over-json */
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { Crypto, Effect, Schema } from "effect";

export const PasskeyRegistrationResponse = Schema.Struct({
	id: Schema.String,
	rawId: Schema.String,
	type: Schema.Literal("public-key"),
	clientExtensionResults: Schema.JsonObject,
	response: Schema.Struct({
		clientDataJSON: Schema.String,
		attestationObject: Schema.String,
		transports: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
	}),
});
export const AddPasskey = Schema.Struct({
	registration: Schema.String,
	label: Schema.String,
	response: PasskeyRegistrationResponse,
});
export type AddPasskey = {
	readonly registration: string;
	readonly label: string;
	readonly response: RegistrationResponseJSON;
};
export const DeletePasskey = Schema.Struct({ id: Schema.String });
export type DeletePasskey = typeof DeletePasskey.Type;
export const validPasskeyId = (id: string) => /^[A-Za-z0-9_-]{1,2048}$/.test(id);
export const validPasskeyLabel = (label: string) =>
	label.length > 0 &&
	label.length <= 128 &&
	label.trim() === label &&
	label.split("").every((value) => value.charCodeAt(0) >= 32 && value.charCodeAt(0) !== 127);
export const registrationBinding = (sessionId: string, label: string) => JSON.stringify([sessionId, label]);
export const canonicalPasskeyDelete = (params: DeletePasskey, sessionId: string) =>
	JSON.stringify([sessionId, params.id]);

/** Bind the fields used by registration verification, including its actual new public key. */
export const canonicalPasskeyAdd = (params: AddPasskey, sessionId: string) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const response = params.response;
		const bytes = new TextEncoder().encode(
			JSON.stringify([
				response.id,
				response.rawId,
				response.type,
				response.response.clientDataJSON,
				response.response.attestationObject,
				response.response.transports ?? null,
			]),
		);
		const digest = Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex");
		return JSON.stringify([sessionId, params.registration, params.label, digest]);
	});
