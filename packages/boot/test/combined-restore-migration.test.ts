import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("migrates exact pre-flip associations conservatively and preserves existing database restore receipts", async (test) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-combined-restore-migration-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/combined-restore-migration.ts"),
		join(directory, "boot.db"),
	]);
	expect(result.stdout).toContain("combined restore migration passed");
});
