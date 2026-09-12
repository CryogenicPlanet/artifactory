import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";

const nativeConfig = process.env.COMMS_FAILED_LEASE_CONFIG;
// Opt-in only: the fixture requires a protected config for the disposable comms_failed_lease database.
for (const mode of ["commit", "rollback", "success-rollback"] as const) {
	it.skipIf(!nativeConfig)(
		`${mode} cleanup cannot pass an open transaction to a queued native borrower`,
		async () => {
			const result = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/failed-lease.ts"), mode], {
				timeout: 20000,
			});
			const report = Schema.decodeUnknownSync(
				Schema.fromJsonString(
					Schema.Struct({
						ok: Schema.Boolean,
						ownerFailed: Schema.Boolean,
						queuedBeforeRelease: Schema.Boolean,
						failureHandlerHeld: Schema.Boolean,
						differentBackend: Schema.Boolean,
						sentinelRows: Schema.Int,
						independentRows: Schema.Int,
					}),
				),
			)(result.stdout);
			expect(report).toMatchObject({
				ok: true,
				ownerFailed: true,
				queuedBeforeRelease: true,
				failureHandlerHeld: true,
				sentinelRows: 0,
				independentRows: 1,
			});
			if (mode !== "success-rollback") expect(report.differentBackend).toBe(true);
		},
		25000,
	);
}

// Run the fixture's separate "nested" mode for diagnostics. Catching failed savepoint cleanup
// inside an outer transaction needs a separate poison contract; these tests do not claim it is safe.
