import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it("backfills FTS and matches only the published image during lost append and rollback", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-search-fault-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await execute("bun", [join(import.meta.dirname, "../fixtures/search-faults.ts"), root]);
	expect(result.stdout).toContain("SEARCH_PUBLISHED");
});
