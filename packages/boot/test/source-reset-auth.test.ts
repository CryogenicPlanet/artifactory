/* oxlint-disable effecttsgo/node-builtin-import */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

for (const scenario of ["binding", "verifier", "replay", "transaction", "late-session"]) {
	test(`source reset authorization: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-reset-auth-test-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/source-reset-auth.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 15000 },
		);
		expect(result.stdout).toContain("source reset auth passed");
	}, 20000);
}
