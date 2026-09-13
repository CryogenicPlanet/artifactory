import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_KERNEL_TEST_CONFIG)(
	"preserves remote migration receipts and refuses uncertain MySQL DDL after its source disappears",
	async () => {
		const fixture = `${import.meta.dirname}/../fixtures/remote-kernel-schema.ts`;
		const result = await promisify(execFile)("bun", [fixture]);
		expect(result.stdout).toContain("KERNEL_SCHEMA_VERIFIED");
		expect((await promisify(execFile)("bun", [fixture, "resume"])).stdout).toContain("KERNEL_RECONNECT_VERIFIED");
	},
	30000,
);
