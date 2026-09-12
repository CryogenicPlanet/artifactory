import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it.for(["reserve-lost", "append-lost"])(
	"publishes a live-only extension diagnostic once after %s and rejects stale writers",
	async (mode, test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-operational-event-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const result = await execute("bun", [
			join(import.meta.dirname, "../fixtures/operational-event-faults.ts"),
			root,
			mode,
		]);
		expect(result.stdout).toContain("OPERATIONAL_EVENT_RECOVERED");
	},
);
