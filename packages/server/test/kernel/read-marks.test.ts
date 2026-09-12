import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it.for(["live", "frozen"])("keeps %s view marks monotonic, epoch-fenced and free of events", async (mode, test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-read-mark-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await execute("bun", [join(import.meta.dirname, "../fixtures/read-mark-faults.ts"), root, mode]);
	expect(result.stdout).toContain("READ_RECOVERED");
});
