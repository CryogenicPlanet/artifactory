import { migrationEpochRunner } from "../fixtures/migration-epoch-runner.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
it.skipIf(!process.env.COMMS_MIGRATION_GUARD_CONFIG)(
	"protects portable migration state without a board-size ceiling",
	async () => {
		const fixture = `${import.meta.dirname}/../fixtures/migration-state-remote.ts`;
		const { stdout } = await promisify(execFile)("bun", [fixture], { timeout: 90000 });
		expect(stdout).toContain("MIGRATION_GUARD_PASSED");
		if (stdout.includes("MIGRATION_GUARD_PASSED mysql")) {
			expect((await promisify(execFile)("bun", [fixture, "resume"], { timeout: 10000 })).stdout).toContain(
				"MIGRATION_GUARD_RECONNECT_PASSED",
			);
			expect((await migrationEpochRunner()).stdout).toContain("MIGRATION_EPOCH_PASSED");
		}
	},
	150000,
);
