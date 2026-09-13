import { Effect, Schema } from "effect";
import type { ExtensionMigrationProof } from "../kernel/transfer-extension-migrations.ts";

export class ExtensionLedgerError extends Schema.TaggedError<ExtensionLedgerError>()("ExtensionLedgerError", {
	code: Schema.Literal("transfer_extension_ledger_invalid"),
}) {}

interface Receipt {
	readonly extension: string;
	readonly name: string;
	readonly checksum: string;
}

/** Match both immutable receipt sets to declarations observed in the frozen target loader.
 * Engine-specific hashes may differ; neither receipt set is rewritten or executed here. */
export const validateExtensionLedger = (
	source: readonly Receipt[],
	target: readonly Receipt[],
	proofs: readonly ExtensionMigrationProof[],
): Effect.Effect<readonly ExtensionMigrationProof[], ExtensionLedgerError> =>
	Effect.gen(function* () {
		const invalid = () => new ExtensionLedgerError({ code: "transfer_extension_ledger_invalid" });
		const key = (row: { readonly extension: string; readonly name: string }) => `${row.extension}\0${row.name}`;
		const validKey = (row: { readonly extension: string; readonly name: string }) =>
			row.extension.length > 0 && row.name.length > 0 && !row.extension.includes("\0") && !row.name.includes("\0");
		const validHash = (value: string) => /^[0-9a-f]{64}(?![\s\S])/.test(value);
		const index = (rows: readonly Receipt[]) =>
			Effect.gen(function* () {
				const entries = new Map<string, string>();
				for (const row of rows) {
					if (!validKey(row) || !validHash(row.checksum) || entries.has(key(row))) return yield* invalid();
					entries.set(key(row), row.checksum);
				}
				return entries;
			});
		const from = yield* index(source);
		const to = yield* index(target);
		if (from.size !== proofs.length || to.size !== proofs.length) return yield* invalid();
		const seen = new Set<string>();
		const resolved: ExtensionMigrationProof[] = [];
		for (const proof of proofs) {
			const id = key(proof);
			if (
				!validKey(proof) ||
				!validHash(proof.sourceChecksum) ||
				!validHash(proof.targetChecksum) ||
				(proof.sourceLegacyChecksum !== undefined && !validHash(proof.sourceLegacyChecksum)) ||
				(proof.targetLegacyChecksum !== undefined && !validHash(proof.targetLegacyChecksum)) ||
				seen.has(id) ||
				!from.has(id) ||
				!to.has(id) ||
				(from.get(id) !== proof.sourceChecksum && from.get(id) !== proof.sourceLegacyChecksum) ||
				(to.get(id) !== proof.targetChecksum && to.get(id) !== proof.targetLegacyChecksum)
			)
				return yield* invalid();
			seen.add(id);
			resolved.push({
				extension: proof.extension,
				name: proof.name,
				sourceChecksum: from.get(id) ?? "",
				targetChecksum: to.get(id) ?? "",
			});
		}
		return resolved.sort(
			(a, b) =>
				Buffer.compare(Buffer.from(a.extension), Buffer.from(b.extension)) ||
				Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
		);
	});
