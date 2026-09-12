import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_TEST_CONFIG || !process.env.COMMS_REMOTE_BOOT_TEST_CONFIG)(
	"runs frozen migrations in the production finite app keeper and proves native account closure",
	async () => {
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/transfer-app-launcher-native.ts")],
			{ timeout: 20000 },
		);
		expect(result.stdout).toContain("TRANSFER_APP_LAUNCHER_NATIVE_VERIFIED");
	},
	25000,
);
