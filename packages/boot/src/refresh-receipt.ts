// Effect Crypto currently exposes random/digest but no HKDF or authenticated encryption.
// This narrow adapter keeps native crypto and its failures inside Effect.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { Crypto, Effect, Schema } from "effect";
import type { MintReceipt } from "./token-mint-schema.ts";
import { type Receipt, TokenPair } from "./refresh-schema.ts";

export class ReceiptError extends Schema.TaggedError<ReceiptError>()("ReceiptError", {}) {}
type Metadata = Pick<Receipt, "family" | "predecessor" | "successor_access_id" | "successor_refresh_id" | "expires_at">;
type MintMetadata = Omit<MintReceipt, "salt" | "nonce" | "ciphertext" | "tag">;
const domain = (meta: Metadata | MintMetadata) => ("session_id" in meta ? "mint" : "refresh");
const aad = (meta: Metadata | MintMetadata) =>
	Buffer.from(
		JSON.stringify([
			`comms-${domain(meta)}-v1`,
			meta.family,
			"session_id" in meta ? [meta.session_id, meta.key_hash, meta.request_hash, meta.proof_hash] : meta.predecessor,
			meta.successor_access_id,
			meta.successor_refresh_id,
			meta.expires_at,
		]),
	);
const key = (secret: string, salt: Buffer, kind: "mint" | "refresh") =>
	Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), salt, `comms-${kind}-receipt-v1`, 32));
const decodeBytes = (value: string, length?: number) => {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid receipt encoding");
	const bytes = Buffer.from(value, "base64url");
	if (bytes.toString("base64url") !== value || (length !== undefined && bytes.length !== length))
		throw new Error("Invalid receipt size");
	return bytes;
};
const seal = <M extends Metadata | MintMetadata>(secret: string, meta: M, pair: TokenPair) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const salt = Buffer.from(yield* crypto.randomBytes(32));
		const nonce = Buffer.from(yield* crypto.randomBytes(12));
		const json = yield* Schema.encodeEffect(Schema.fromJsonString(TokenPair))(pair);
		return yield* Effect.try({
			try: () => {
				const cipher = createCipheriv("aes-256-gcm", key(secret, salt, domain(meta)), nonce);
				cipher.setAAD(aad(meta));
				const ciphertext = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
				return {
					...meta,
					salt: salt.toString("base64url"),
					nonce: nonce.toString("base64url"),
					ciphertext: ciphertext.toString("base64url"),
					tag: cipher.getAuthTag().toString("base64url"),
				};
			},
			catch: () => new ReceiptError({}),
		});
	});
const open = (secret: string, receipt: Receipt | MintReceipt) =>
	Effect.gen(function* () {
		const json = yield* Effect.try({
			try: () => {
				const decipher = createDecipheriv(
					"aes-256-gcm",
					key(secret, decodeBytes(receipt.salt, 32), domain(receipt)),
					decodeBytes(receipt.nonce, 12),
				);
				decipher.setAAD(aad(receipt));
				decipher.setAuthTag(decodeBytes(receipt.tag, 16));
				return Buffer.concat([decipher.update(decodeBytes(receipt.ciphertext)), decipher.final()]).toString("utf8");
			},
			catch: () => new ReceiptError({}),
		});
		return yield* Schema.decodeEffect(Schema.fromJsonString(TokenPair))(json, { onExcessProperty: "error" }).pipe(
			Effect.mapError(() => new ReceiptError({})),
		);
	});

export const sealReceipt = (secret: string, meta: Metadata, pair: TokenPair) => seal(secret, meta, pair);
export const openReceipt = (secret: string, receipt: Receipt) => open(secret, receipt);
export const sealMintReceipt = (secret: string, meta: MintMetadata, pair: TokenPair) => seal(secret, meta, pair);
export const openMintReceipt = (secret: string, receipt: MintReceipt) => open(secret, receipt);
