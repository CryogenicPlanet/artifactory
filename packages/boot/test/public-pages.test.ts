import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("bounds admission behind restore, releases its gate, and reads replacement stores without creating missing ones", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-public-policy-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/public-pages.ts"), root]);
	expect(JSON.parse(result.stdout)).toEqual({
		beforeSettlement: 0,
		settled: "published once",
		writes: 1,
		stuck: "Failure",
		initial: true,
		blocked: "Failure",
		after: true,
		reservation: "Failure",
		deleted: true,
		refused: "Failure",
		replacement: false,
		missing: "Failure",
		notCreated: true,
	});
});
