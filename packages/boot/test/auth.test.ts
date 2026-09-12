/* oxlint-disable effecttsgo/node-builtin-import */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

for (const scenario of ["setup", "registration-validation", "login-validation", "sessions"]) {
	test(`passkey core: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-auth-test-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/auth-run.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 20_000 },
		);
		expect(result.stdout).toContain("auth scenario passed");
		if (scenario === "sessions") {
			const restarted = await promisify(execFile)(
				"bun",
				[join(import.meta.dirname, "fixtures/auth-run.ts"), join(directory, "boot.db"), "resume"],
				{ timeout: 20_000 },
			);
			expect(restarted.stdout).toContain("auth scenario passed");
		}
	}, 25_000);
}
