import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("runs frozen migrations in a finite app-only keeper and refuses stale, invalid and failed task results", async () => {
	const result = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/transfer-app-launcher.ts")], {
		timeout: 20000,
		env: {
			...process.env,
			BOOT_DATABASE_URL: "must-not-reach-child",
			COMMS_REMOTE_TRANSFER_CONFIG: "must-not-reach-child",
		},
	});
	expect(result.stdout).toContain("TRANSFER_APP_LAUNCHER_VERIFIED");
}, 25000);
