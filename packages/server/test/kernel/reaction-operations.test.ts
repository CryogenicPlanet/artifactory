import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it.for(["reserve-lost", "append-before", "append-lost", "sql-failure"])(
	"preserves published toggle state and retry receipts after %s",
	async (mode, test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-reaction-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const result = await execute("bun", [join(import.meta.dirname, "../fixtures/reaction-faults.ts"), root, mode]);
		expect(result.stdout).toContain("REACTIONS_RECOVERED");
	},
);
