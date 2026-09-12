import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_CORE_TEST_CONFIG)(
	"initializes remote core history and preserves receipts, both search images and data after reconnect",
	async () => {
		const { stdout } = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/remote-core-schema.ts")], {
			timeout: 30000,
			env: process.env,
		});
		expect(stdout).toContain(
			"core native defaults, long values, receipt hashes, search and reconnect durability passed",
		);
	},
	35000,
);
