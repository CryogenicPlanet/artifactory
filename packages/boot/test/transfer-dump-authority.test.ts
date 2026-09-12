import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("requires the exact ready offline boot dump resource, credentials and private journal", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-dump-authority-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/transfer-dump-authority.ts"),
		root,
	]);
	expect(result.stdout).toContain("verified exact offline dump authority");
}, 30000);
