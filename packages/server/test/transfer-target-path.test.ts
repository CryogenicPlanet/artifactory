import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it("accepts the volume-root SQLite boot file and refuses parent escape and file aliases", async (test) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-transfer-target-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const result = await execute("bun", [join(import.meta.dirname, "fixtures/transfer-target-path.ts"), directory]);
	expect(result.stdout).toContain("Target root parent and alias refusal verified");
});
