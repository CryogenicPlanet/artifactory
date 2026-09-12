import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("binds original selection transactionally without opening it or storing credentials", async () => {
	const { stdout, stderr } = await promisify(execFile)("bun", [
		`${import.meta.dirname}/fixtures/remote-restore-selection.ts`,
	]);
	expect(stdout).toContain("selection-proved");
	expect(stdout + stderr).not.toContain("never-print");
});
