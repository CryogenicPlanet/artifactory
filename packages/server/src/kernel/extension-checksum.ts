import { Crypto, Effect } from "effect";

/** Receipt identity includes protection intent. Legacy SQL-only receipts permit replay only, never ownership inference. */
export const extensionChecksums = (
	statement: string,
	options?: { readonly protect?: boolean; readonly unprotect?: string },
) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const hash = (text: string) =>
			crypto
				.digest("SHA-256", new TextEncoder().encode(text))
				.pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
		return {
			checksum: yield* hash(JSON.stringify([statement, options?.protect ?? false, options?.unprotect ?? null])),
			...(options?.unprotect === undefined ? { legacyChecksum: yield* hash(statement) } : {}),
		};
	});
