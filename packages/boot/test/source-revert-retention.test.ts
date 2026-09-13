import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it.for(["clock", "legacy", "accept-rollback", "restart"])(
	"source undo receipt retention: %s",
	{ timeout: 15000 },
	async (scenario, test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-undo-retention-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const run = (name: string) =>
			execute("bun", [join(import.meta.dirname, "fixtures/source-revert-retention.ts"), root, name]);
		if (scenario === "restart") {
			expect((await run("restart-seed")).stdout).toContain("passed");
			expect((await run("restart-read")).stdout).toContain("passed");
		} else expect((await run(scenario)).stdout).toContain(`retention ${scenario} passed`);
	},
);
