import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);
for (const scenario of ["authority", "remove-before", "file-before", "remove-after", "file-after"] as const) {
	test(`source reset publication boundary: ${scenario}`, async ({ onTestFinished }) => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "comms-reset-boundary-test-")));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const result = await execute("bun", [
			join(import.meta.dirname, "fixtures/source-reset-boundary.ts"),
			root,
			scenario,
		]);
		expect(result.stdout).toContain(`source reset boundary ${scenario} passed`);
	});
}
