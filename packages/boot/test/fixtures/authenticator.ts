// Native crypto builds genuine WebAuthn test responses for the production verifier.
/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

export const authenticator = (saved?: { readonly id: string; readonly privateKey: string }) => {
	const privateKey = saved ? createPrivateKey(saved.privateKey) : generateKeyPairSync("ed25519").privateKey;
	const key = { privateKey, publicKey: createPublicKey(privateKey) };
	const jwk = key.publicKey.export({ format: "jwk" });
	if (!jwk.x) throw new Error("Missing public key");
	const id = saved?.id ?? randomBytes(24).toString("base64url");
	const publicKey = isoCBOR.encode(
		new Map<number, number | Uint8Array>([
			[1, 1],
			[3, -8],
			[-1, 6],
			[-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))],
		]),
	);
	const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest();
	const counterBytes = (counter: number) => {
		const data = Buffer.alloc(4);
		data.writeUInt32BE(counter);
		return data;
	};
	const registration = (
		challenge: string,
		origin = "https://comms.test",
		rpId = "comms.test",
		uv = true,
	): RegistrationResponseJSON => {
		const credentialId = Buffer.from(id, "base64url");
		const length = Buffer.alloc(2);
		length.writeUInt16BE(credentialId.length);
		const authData = Buffer.concat([
			hash(rpId),
			Buffer.from([uv ? 0x45 : 0x41]),
			counterBytes(0),
			Buffer.alloc(16),
			length,
			credentialId,
			publicKey,
		]);
		const attestation = isoCBOR.encode(
			new Map<string, string | Uint8Array | Map<string, string>>([
				["fmt", "none"],
				["attStmt", new Map<string, string>()],
				["authData", new Uint8Array(authData)],
			]),
		);
		return {
			id,
			rawId: id,
			type: "public-key",
			clientExtensionResults: {},
			response: {
				clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin })).toString(
					"base64url",
				),
				attestationObject: Buffer.from(attestation).toString("base64url"),
				transports: ["internal"],
			},
		};
	};
	const assertion = (
		challenge: string,
		counter = 1,
		origin = "https://comms.test",
		rpId = "comms.test",
		uv = true,
	): AuthenticationResponseJSON => {
		const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin }));
		const data = Buffer.concat([hash(rpId), Buffer.from([uv ? 5 : 1]), counterBytes(counter)]);
		return {
			id,
			rawId: id,
			type: "public-key",
			clientExtensionResults: {},
			response: {
				clientDataJSON: client.toString("base64url"),
				authenticatorData: data.toString("base64url"),
				signature: sign(null, Buffer.concat([data, hash(client)]), key.privateKey).toString("base64url"),
			},
		};
	};
	return {
		id,
		registration,
		assertion,
		state: { id, privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString() },
	};
};
