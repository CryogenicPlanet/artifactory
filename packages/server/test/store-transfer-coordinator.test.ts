import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it.for(["complete", "boot-gap", "app-gap", "pending", "nested", "controls", "conflict"])(
	"offline SQL transfer preserves its authority boundary: %s",
	async (mode, test) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-transfer-"));
		test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await execute("bun", [
			join(import.meta.dirname, "fixtures/store-transfer-coordinator.ts"),
			directory,
			mode,
		]);
		expect(result.stdout).toContain(`Verified ${mode}`);
	},
);
