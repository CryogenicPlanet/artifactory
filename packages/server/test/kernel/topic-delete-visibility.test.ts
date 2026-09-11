import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it("hides deleted subtrees only after publication and prevents recreation", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-topic-fault-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await execute("bun", [
		join(import.meta.dirname, "../fixtures/topic-delete-visibility.ts"),
		root,
		"visibility",
	]);
	expect(result.stdout).toContain("TOPIC_VISIBILITY_VERIFIED");
});
