import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
it.for(["success", "ancestors", "validation", "sql-failure", "reserve-lost", "stale", "reserved-event"])(
	"preserves topic move transaction guarantees for %s",
	async (mode, test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-topic-move-test-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const result = await execute("bun", [join(import.meta.dirname, "../fixtures/topic-move-faults.ts"), root, mode]);
		expect(result.stdout).toContain("MOVE_VERIFIED");
	},
);
