import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_TEST_CONFIG)(
	"proves account-wide remote closure on a disposable native server",
	async () => {
		const result = await promisify(execFile)(
			process.execPath,
			[join(import.meta.dirname, "fixtures/remote-owner-inspection.ts")],
			{ env: process.env },
		);
		expect(result.stdout).toContain("REMOTE_OWNER_VERIFIED");
	},
	30000,
);
