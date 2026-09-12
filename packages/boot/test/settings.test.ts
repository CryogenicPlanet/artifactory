import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
for (const scenario of ["binding", "transaction", "http", "schema", "late-session", "retention", "obsolete"])
	test(`signed settings: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-settings-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/settings.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 15000 },
		);
		expect(result.stdout).toContain("settings passed");
	}, 20000);

test("signed settings retain exact first outcome after process restart and later update", async ({
	onTestFinished,
}) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-settings-restart-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	for (const scenario of ["persist", "resume"]) {
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/settings.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 15000 },
		);
		expect(result.stdout).toContain("settings passed");
	}
}, 20000);
