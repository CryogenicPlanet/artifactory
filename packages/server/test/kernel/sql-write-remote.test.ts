import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
it.skipIf(!process.env.COMMS_REMOTE_SQL_WRITE_TEST_CONFIG)(
	"remote repairs roll back protected FK changes and replay committed DML after physical reconnect",
	async () => {
		const run = (mode: string) =>
			promisify(execFile)("bun", [join(import.meta.dirname, "../fixtures/remote-sql-write.ts"), mode], {
				env: process.env,
				timeout: 30000,
			});
		try {
			expect((await run("prepare")).stdout).toContain("REMOTE_SQL_WRITE_VERIFIED prepare");
			expect((await run("resume")).stdout).toContain("REMOTE_SQL_WRITE_VERIFIED resume");
		} finally {
			await run("cleanup");
		}
	},
	65000,
);
