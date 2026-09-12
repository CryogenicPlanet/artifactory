import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_TRANSFER_APP_NATIVE_TEST)(
	"initializes frozen app migrations through real remote keepers and preserves identity",
	async () => {
		const { stdout } = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/transfer-app-initialize-native.ts")],
			{ timeout: 45000, env: process.env },
		);
		expect(stdout).toContain("TRANSFER_APP_CHILD_VERIFIED");
		expect(stdout).toContain("TRANSFER_APP_INITIALIZE_NATIVE_PASSED");
	},
	50000,
);
