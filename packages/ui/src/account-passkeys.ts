import { assertionHeader } from "@comms/protocol/headers";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { BoardError } from "./board-api.ts";
import { accountPost, accountRequest, unreadable } from "./account-api.ts";

const descriptor = Schema.Struct({ id: Schema.String, type: Schema.Literal("public-key") });
const Authentication = Schema.Struct({
	id: Schema.String,
	options: Schema.Struct({
		challenge: Schema.String,
		rpId: Schema.String,
		timeout: Schema.Finite,
		userVerification: Schema.Literals(["required", "preferred", "discouraged"]),
		allowCredentials: Schema.optionalKey(Schema.Array(descriptor)),
	}),
});
const Registration = Schema.Struct({
	id: Schema.String,
	options: Schema.Struct({
		challenge: Schema.String,
		rp: Schema.Struct({ id: Schema.String, name: Schema.String }),
		user: Schema.Struct({ id: Schema.String, name: Schema.String, displayName: Schema.String }),
		pubKeyCredParams: Schema.Array(Schema.Struct({ type: Schema.Literal("public-key"), alg: Schema.Finite })),
		timeout: Schema.Finite,
		excludeCredentials: Schema.optionalKey(Schema.Array(descriptor)),
	}),
});
const decode = (value: string) =>
	Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (letter) => letter.charCodeAt(0));
const encode = (value: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(value)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
const ceremonyError = () =>
	new BoardError({
		status: 0,
		message: "Passkey confirmation was canceled or unavailable. Use HTTPS or localhost and try again.",
	});
export const confirmAccountAction = (action: string, params: unknown) =>
	Effect.gen(function* () {
		const started = yield* accountPost("/_boot/auth/challenge", { action, params }).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Authentication)),
			Effect.catchTag("SchemaError", () => unreadable),
		);
		const credential = yield* Effect.tryPromise({
			try: () =>
				navigator.credentials.get({
					publicKey: {
						...started.options,
						challenge: decode(started.options.challenge),
						allowCredentials: (started.options.allowCredentials ?? []).map((item) => ({
							...item,
							id: decode(item.id),
						})),
					},
				}),
			catch: ceremonyError,
		});
		if (
			!(credential instanceof PublicKeyCredential) ||
			!(credential.response instanceof AuthenticatorAssertionResponse)
		)
			return yield* ceremonyError();
		const response = credential.response;
		const extensions = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
			credential.getClientExtensionResults(),
		).pipe(Effect.catchTag("SchemaError", () => unreadable));
		const proof = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
			id: started.id,
			response: {
				id: credential.id,
				rawId: encode(credential.rawId),
				type: "public-key",
				clientExtensionResults: extensions,
				response: {
					clientDataJSON: encode(response.clientDataJSON),
					authenticatorData: encode(response.authenticatorData),
					signature: encode(response.signature),
					...(response.userHandle ? { userHandle: encode(response.userHandle) } : {}),
				},
			},
		}).pipe(Effect.catchTag("SchemaError", () => unreadable));
		return encode(new TextEncoder().encode(proof));
	});
export const addPasskey = (label: string) =>
	Effect.gen(function* () {
		const started = yield* accountPost("/_boot/auth/passkeys/options", { label }).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Registration)),
			Effect.catchTag("SchemaError", () => unreadable),
		);
		const response = yield* registerPasskey(started);
		const proof = yield* confirmAccountAction("passkey.add", { registration: started.id, label, response });
		yield* accountPost("/_boot/auth/passkeys/verify", { id: started.id, label, response }, proof);
	});
export const deletePasskey = (id: string) =>
	Effect.gen(function* () {
		const proof = yield* confirmAccountAction("passkey.delete", { id });
		yield* accountRequest(
			HttpClientRequest.delete(
				new URL(`/_boot/auth/passkeys/${encodeURIComponent(id)}`, window.location.origin).href,
			).pipe(HttpClientRequest.bodyJsonUnsafe({}), HttpClientRequest.setHeader(assertionHeader, proof)),
		);
	});

const registerPasskey = (started: typeof Registration.Type) =>
	Effect.gen(function* () {
		const credential = yield* Effect.tryPromise({
			try: () =>
				navigator.credentials.create({
					publicKey: {
						...started.options,
						challenge: decode(started.options.challenge),
						user: { ...started.options.user, id: decode(started.options.user.id) },
						pubKeyCredParams: [...started.options.pubKeyCredParams],
						excludeCredentials: (started.options.excludeCredentials ?? []).map((item) => ({
							...item,
							id: decode(item.id),
						})),
						attestation: "none",
						authenticatorSelection: { residentKey: "required", userVerification: "required" },
					},
				}),
			catch: ceremonyError,
		});
		if (
			!(credential instanceof PublicKeyCredential) ||
			!(credential.response instanceof AuthenticatorAttestationResponse)
		)
			return yield* ceremonyError();
		const extensions = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
			credential.getClientExtensionResults(),
		).pipe(Effect.catchTag("SchemaError", () => unreadable));
		return {
			id: credential.id,
			rawId: encode(credential.rawId),
			type: "public-key",
			clientExtensionResults: extensions,
			response: {
				clientDataJSON: encode(credential.response.clientDataJSON),
				attestationObject: encode(credential.response.attestationObject),
				transports: credential.response.getTransports(),
			},
		};
	});

/** First registration proves possession but does not create a login session. */
export const setupPasskey = (code: string) =>
	Effect.gen(function* () {
		const started = yield* accountPost("/_boot/auth/setup/options", { code: code.trim() }).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Registration)),
			Effect.catchTag("SchemaError", () => unreadable),
		);
		const response = yield* registerPasskey(started);
		yield* accountPost("/_boot/auth/setup/verify", { id: started.id, response });
	});
