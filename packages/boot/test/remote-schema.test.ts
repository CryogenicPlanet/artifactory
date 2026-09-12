import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_BOOT_TEST_CONFIG)(
	"initializes remote boot history and preserves constraints, long values and durable data on reopen",
	async () => {
		const { stdout } = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/remote-schema.ts")], {
			timeout: 30000,
			env: process.env,
		});
		expect(stdout).toContain("boot native constraints, long values, binary, sequence and reopen durability passed");
	},
	35000,
);
