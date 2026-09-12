import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
it("migration transactions preserve identity, recovery rows and receipts while allowing application upgrades", async () => {
	const { stdout } = await promisify(execFile)("bun", [join(import.meta.dirname, "../fixtures/migration-state.ts")], {
		timeout: 15000,
	});
	expect(stdout).toContain("MIGRATION_STATE_PRESERVED");
}, 20000);
