import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
it.for(["copy", "changed-source", "populated-target"])("exhaustive transfer data plan: %s", async (mode, test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-data-plan-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "../fixtures/transfer/data-plan.ts"),
		root,
		mode,
	]);
	expect(result.stdout).toContain(`Verified ${mode}`);
});
