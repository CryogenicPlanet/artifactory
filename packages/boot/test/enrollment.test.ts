import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

for (const scenario of ["proof", "rollback", "collection", "denial", "migration"]) {
	test(`enrollment: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-enrollment-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const run = (name: string) =>
			promisify(execFile)(
				"bun",
				[join(import.meta.dirname, "fixtures/enrollment-run.ts"), join(directory, "boot.db"), name],
				{ timeout: 20000 },
			);
		expect((await run(scenario)).stdout).toContain("enrollment scenario passed");
		if (scenario === "collection") expect((await run("resume")).stdout).toContain("enrollment scenario passed");
	}, 25000);
}
