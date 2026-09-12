/* oxlint-disable effecttsgo/node-builtin-import */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

for (const scenario of [
	"persist-process",
	"binding",
	"registration-validation",
	"assertion-validation",
	"transaction-restart",
	"last-key",
	"late-session",
]) {
	test(`passkey management: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-passkey-management-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/passkey-management.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 20_000 },
		);
		expect(result.stdout).toContain("passkey management passed");
		if (scenario === "persist-process") {
			const resumed = await promisify(execFile)(
				"bun",
				[join(import.meta.dirname, "fixtures/passkey-management.ts"), join(directory, "boot.db"), "resume-process"],
				{ timeout: 20_000 },
			);
			expect(resumed.stdout).toContain("passkey management passed");
		}
	}, 25_000);
}
