import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_BUNDLED_EXTENSIONS_TEST_CONFIG)(
	"loads bundled extensions and preserves large cursors, timestamp values and case-sensitive subscription retries",
	async () => {
		const { stdout } = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/bundled-extensions-native.ts")],
			{
				timeout: 30000,
				env: process.env,
			},
		);
		expect(stdout).toContain("BUNDLED_EXTENSIONS_NATIVE_PASSED");
	},
	35000,
);
