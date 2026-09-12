import { Crypto, Effect, Schema, Semaphore } from "effect";
import { transferJsonCanonical } from "./transfer-json.ts";

export type TransferKind = "integer" | "text" | "bytes" | "real" | "json";
export type TransferValue =
	| { readonly kind: "null"; readonly value: null }
	| { readonly kind: "integer"; readonly value: number | bigint }
	| { readonly kind: "text" | "json"; readonly value: string }
	| { readonly kind: "bytes"; readonly value: Uint8Array }
	| { readonly kind: "real"; readonly value: number };

export class TransferValueError extends Schema.TaggedError<TransferValueError>()("TransferValueError", {
	code: Schema.Literals(["transfer_value_invalid", "transfer_json_invalid", "transfer_json_duplicate_key"]),
}) {}

/** No coercion of binary/text values or already-rounded numbers. Errors never include row contents.
 * JSON requires a trusted column policy and a raw textual database projection.
 */
export const decodeTransferValue = (
	kind: TransferKind,
	raw: unknown,
): Effect.Effect<TransferValue, TransferValueError> =>
	Effect.gen(function* () {
		if (raw === null) return { kind: "null", value: null };
		switch (kind) {
			case "json":
				if (typeof raw !== "string") return yield* new TransferValueError({ code: "transfer_json_invalid" });
				yield* transferJsonCanonical(raw).pipe(
					Effect.mapError((error) => new TransferValueError({ code: error.code })),
				);
				return { kind, value: raw };
			case "integer":
				if (typeof raw === "bigint") return { kind, value: raw };
				if (typeof raw === "number" && Number.isSafeInteger(raw)) return { kind, value: raw === 0 ? 0 : raw };
				if (typeof raw === "string" && /^-?(0|[1-9][0-9]*)$/.test(raw)) return { kind, value: BigInt(raw) };
				break;
			case "text":
				// TextEncoder replaces unpaired UTF-16 surrogates, silently changing the value being verified.
				if (typeof raw === "string" && raw.isWellFormed()) return { kind, value: raw };
				break;
			case "bytes":
				if (raw instanceof Uint8Array) return { kind, value: new Uint8Array(raw) };
				break;
			case "real":
				if (typeof raw === "number" && Number.isFinite(raw)) return { kind, value: raw };
				break;
		}
		return yield* new TransferValueError({ code: "transfer_value_invalid" });
	});

// Each frame is an ASCII tag, the decimal byte length, a colon, then those exact bytes.
const frame = (tag: string, bytes: Uint8Array): Uint8Array => {
	const header = new TextEncoder().encode(`${tag}${bytes.byteLength}:`);
	const framed = new Uint8Array(header.byteLength + bytes.byteLength);
	framed.set(header);
	framed.set(bytes, header.byteLength);
	return framed;
};

const encoded = (value: TransferValue): Uint8Array => {
	switch (value.kind) {
		case "null":
			return frame("null", new Uint8Array());
		case "bytes":
			return frame("bytes", value.value);
		case "json":
		case "text":
			return frame("text", new TextEncoder().encode(value.value));
		case "integer":
			return frame("integer", new TextEncoder().encode(value.value.toString()));
		case "real": {
			// Network-order IEEE 754 preserves every finite binary64 value, including negative zero.
			const bytes = new Uint8Array(8);
			new DataView(bytes.buffer).setFloat64(0, value.value, false);
			return frame("real", bytes);
		}
	}
};

/** SHA-256 chain over framed cells and explicit row/end boundaries, using one cell of extra memory.
 * Supply rows in the same deterministic order on both stores, and columns in schema order.
 * This digest does not sort rows, normalize Unicode, or equate integer and real columns.
 * Bind `TransferValue.value` directly; readers must retain raw bytes and exact integer values.
 */
export const makeTransferDigest = Effect.gen(function* () {
	const crypto = yield* Crypto.Crypto;
	const gate = yield* Semaphore.make(1);
	let digest = new Uint8Array(yield* crypto.digest("SHA-256", new TextEncoder().encode("comms-transfer-v1")));
	const step = (current: Uint8Array, bytes: Uint8Array) =>
		Effect.gen(function* () {
			const input = new Uint8Array(current.byteLength + bytes.byteLength);
			input.set(current);
			input.set(bytes, current.byteLength);
			return new Uint8Array(yield* crypto.digest("SHA-256", input));
		});
	return {
		append: (row: readonly TransferValue[]) =>
			gate.withPermit(
				Effect.gen(function* () {
					let next = yield* step(digest, frame("row", new TextEncoder().encode(row.length.toString())));
					for (const value of row) {
						const checked =
							value.kind === "null"
								? yield* decodeTransferValue("text", value.value)
								: yield* decodeTransferValue(value.kind, value.value);
						if (checked.kind === "json") {
							const canonical = yield* transferJsonCanonical(checked.value).pipe(
								Effect.mapError((error) => new TransferValueError({ code: error.code })),
							);
							next = yield* step(next, frame("json", new TextEncoder().encode(canonical)));
						} else next = yield* step(next, encoded(checked));
					}
					// A rejected or interrupted row cannot partially change the chain.
					digest = next;
				}),
			),
		finish: gate.withPermit(
			Effect.gen(function* () {
				const final = yield* step(digest, frame("end", new Uint8Array()));
				return Array.from(final, (byte) => byte.toString(16).padStart(2, "0")).join("");
			}),
		),
	};
});

/** Iterable convenience wrapper over the same incremental digest used by bounded row readers. */
export const digestTransferRows = (rows: Iterable<readonly TransferValue[]>) =>
	Effect.gen(function* () {
		const digest = yield* makeTransferDigest;
		for (const row of rows) yield* digest.append(row);
		return yield* digest.finish;
	});
