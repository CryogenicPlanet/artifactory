import { Effect } from "effect";
import { expect, it } from "vitest";
import { validateExtensionLedger } from "../../src/transfer/extension-ledger.ts";

const fixture = () => {
	const source = [{ extension: "example.ts", name: "create", checksum: "a".repeat(64) }];
	const target = [{ extension: "example.ts", name: "create", checksum: "b".repeat(64) }];
	const proofs = [
		{ extension: "example.ts", name: "create", sourceChecksum: "a".repeat(64), targetChecksum: "b".repeat(64) },
	];
	return { source, target, proofs };
};

it("accepts exact declared branch hashes without rewriting either ledger", async () => {
	const { source, target, proofs } = fixture();
	expect(await Effect.runPromise(validateExtensionLedger(source, target, proofs))).toEqual(proofs);
	expect(source[0]?.checksum).toBe("a".repeat(64));
	expect(target[0]?.checksum).toBe("b".repeat(64));
	expect(await Effect.runPromise(validateExtensionLedger([], [], []))).toEqual([]);
});

it("refuses missing, extra, altered and duplicate receipts or declarations", async () => {
	const { source, target, proofs } = fixture();
	const runs = [
		validateExtensionLedger([], target, proofs),
		validateExtensionLedger(source, [], proofs),
		validateExtensionLedger(source, target, []),
		validateExtensionLedger(
			source.map((row) => ({ ...row, checksum: "c".repeat(64) })),
			target,
			proofs,
		),
		validateExtensionLedger(
			source,
			target.map((row) => ({ ...row, checksum: "c".repeat(64) })),
			proofs,
		),
		validateExtensionLedger([...source, ...source], target, proofs),
		validateExtensionLedger(source, [...target, ...target], proofs),
		validateExtensionLedger(source, target, [...proofs, ...proofs]),
		validateExtensionLedger(
			source,
			target,
			proofs.map((row) => ({ ...row, name: "different" })),
		),
		validateExtensionLedger(
			source,
			target,
			proofs.map((row) => ({ ...row, sourceChecksum: `${row.sourceChecksum}\n` })),
		),
	];
	for (const run of runs) expect((await Effect.runPromise(Effect.result(run)))._tag).toBe("Failure");
});

it("returns one canonical order independent of engine catalog ordering", async () => {
	const rows = ["z", "a", "🦋", "é"].map((extension) => ({ extension, name: "create", checksum: "a".repeat(64) }));
	const proofs = rows.map(({ extension, name, checksum }) => ({
		extension,
		name,
		sourceChecksum: checksum,
		targetChecksum: checksum,
	}));
	const result = await Effect.runPromise(validateExtensionLedger(rows, rows.toReversed(), proofs.toReversed()));
	expect(result.map((row) => row.extension)).toEqual(["a", "z", "é", "🦋"]);
});

it("resolves mixed legacy and current receipts without changing frozen evidence", async () => {
	const { source, target, proofs } = fixture();
	const declarations = proofs.map((proof) =>
		Object.freeze({ ...proof, sourceChecksum: "c".repeat(64), sourceLegacyChecksum: proof.sourceChecksum }),
	);
	const before = JSON.stringify({ source, target, declarations });
	expect(await Effect.runPromise(validateExtensionLedger(source, target, declarations))).toEqual(proofs);
	expect(JSON.stringify({ source, target, declarations })).toBe(before);
	for (const candidate of ["a".repeat(63), `${"a".repeat(64)}\n`, "g".repeat(64)]) {
		expect(
			(
				await Effect.runPromise(
					Effect.result(
						validateExtensionLedger(
							source,
							target,
							declarations.map((row) => ({ ...row, sourceLegacyChecksum: candidate })),
						),
					),
				)
			)._tag,
		).toBe("Failure");
	}
	// A different current options digest is neither the declared digest nor its SQL-only legacy receipt.
	expect(
		(
			await Effect.runPromise(
				Effect.result(
					validateExtensionLedger(
						source.map((row) => ({ ...row, checksum: "d".repeat(64) })),
						target,
						declarations,
					),
				),
			)
		)._tag,
	).toBe("Failure");
});
