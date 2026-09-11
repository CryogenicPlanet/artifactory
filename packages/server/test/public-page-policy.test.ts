import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("reconstructs grants before routing with one bounded durable snapshot, epoch retries and private listing filters", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-page-policy-test-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const { stdout } = await promisify(execFile)(
		"bun",
		[join(import.meta.dirname, "fixtures/public-page-policy.ts"), root],
		{ timeout: 20000 },
	);
	expect(stdout).toContain("PUBLIC_PAGE_POLICY_VERIFIED");
}, 30000);
