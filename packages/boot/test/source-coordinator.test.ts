import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);
for (const scenario of ["borrowed", "acceptance-failure", "cancelled", "publication-failure"] as const) {
	test(`source coordinator: ${scenario}`, async ({ onTestFinished }) => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "comms-source-coordinator-test-")));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const result = await execute("bun", [join(import.meta.dirname, "fixtures/source-coordinator.ts"), root, scenario]);
		expect(result.stdout).toContain(`source coordinator ${scenario} passed`);
	});
}
