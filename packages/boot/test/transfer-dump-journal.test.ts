import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("recovers external dump allocations and refuses foreign, malformed or linked resources", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-transfer-dump-journal-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/transfer-dump-journal.ts"),
		root,
	]);
	expect(result.stdout).toContain("verified external dump journal recovery");
}, 30000);
