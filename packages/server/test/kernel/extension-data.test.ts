import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it.for(["reserve-lost", "append-before", "append-lost", "sql-failure"])(
	"fences extension scratch writes and logs, isolates namespaces, and recovers after %s",
	async (mode, test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-extension-data-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const result = await execute("bun", [
			join(import.meta.dirname, "../fixtures/extension-data-faults.ts"),
			root,
			mode,
		]);
		expect(result.stdout).toContain("EXTENSION_DATA_RECOVERED");
	},
);
