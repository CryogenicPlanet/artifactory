import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("migrates legacy backups without inventing their publication fence or generation", async (test) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-backup-metadata-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/backup-metadata.ts"),
		join(directory, "boot.db"),
	]);
	expect(result.stdout).toContain("backup metadata preserved");
});
