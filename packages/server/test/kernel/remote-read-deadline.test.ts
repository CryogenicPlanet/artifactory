import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it
	.skipIf(!process.env.COMMS_READ_CLEANUP_CONFIG)
	.each([
		"clean",
		"nested",
		"queued",
		"rollback-defect",
		"cleanup-wait",
		"cleanup-overrun",
		"cancel-overrun",
		"queued-outer-mask",
	])(
	"preserves remote snapshot cleanup and quiescence: %s",
	async (mode) => {
		expect(["pg", "mysql"]).toContain(process.env.COMMS_TEST_ENGINE);
		const { stdout } = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "../fixtures/read-deadline.ts"), mode],
			{ timeout: 15000 },
		);
		expect(stdout).toContain("READ_DEADLINE_VERIFIED");
	},
	20000,
);
