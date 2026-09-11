import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("checks exact public grants and safe paths without an app store or publication fence", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-public-policy-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/public-pages.ts"), root]);
	expect(JSON.parse(result.stdout)).toEqual({
		initial: true,
		directory: true,
		childPrivate: true,
		unsafe: true,
		pending: true,
		deleted: true,
		notCreated: true,
	});
});
