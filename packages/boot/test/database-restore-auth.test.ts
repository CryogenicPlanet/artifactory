/* oxlint-disable effecttsgo/node-builtin-import */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

for (const scenario of ["http-challenge", "binding", "semantic", "transaction", "replay", "idempotency"]) {
	test(`database restore authorization: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-restore-auth-test-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/database-restore-auth.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 15000 },
		);
		expect(result.stdout).toContain("database restore auth passed");
	}, 20000);
}
