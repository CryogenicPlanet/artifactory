import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("preserves capacity refusals through manual and guarded child backup adapters", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-backup-refusal-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/backup-refusal-http.ts"),
		join(root, "boot.db"),
	]);
	expect(result.stdout).toContain("BACKUP_REFUSAL_VERIFIED");
});
