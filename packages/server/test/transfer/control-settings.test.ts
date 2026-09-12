import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
const fixture = async (test: TestContext, mode: string) => {
	const root = await mkdtemp(join(tmpdir(), "comms-inspect-settings-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "store"));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "../fixtures/transfer/control-tables.ts"),
		root,
		mode,
	]);
	return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(result.stdout);
};
it("inspects source settings for a scratch path without granting runtime copy authority", async (test) => {
	expect(await fixture(test, "inspect")).toMatchObject({
		inspected: { _tag: "Success", value: { rows: 11, digest: expect.stringMatching(/^[0-9a-f]{64}(?![\s\S])/) } },
		strict: { _tag: "Failure" },
		sourceUnchanged: true,
		targetRows: [{ count: 5 }],
	});
});
it("retains pending receipt refusal in read-only scratch inspection", async (test) => {
	expect(await fixture(test, "inspect-pending")).toMatchObject({
		inspected: { _tag: "Failure" },
		strict: { _tag: "Failure" },
		sourceUnchanged: true,
		targetRows: [{ count: 5 }],
	});
});
