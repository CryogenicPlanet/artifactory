import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
const fixture = async (test: TestContext, mode: string) => {
	const root = await mkdtemp(join(tmpdir(), "comms-controls-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "store"));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "../fixtures/transfer/control-tables.ts"),
		root,
		mode,
	]);
	return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(result.stdout);
};
it("preserves sequence and exact settings bytes, archives old authority and resumes through retirement", async (test) => {
	expect(await fixture(test, "copy")).toMatchObject({
		result: { _tag: "Success", value: { unchanged: true, corruptionDetected: true } },
		targetSequence: [{ next: 91, published_through: 90 }],
		activeRemote: [],
		watcher: [{ value: '  日本語😀\n{ "bytes" : "unchanged" }  ' }],
		controls: [
			{ key: "app_store_schema", value: "target schema bytes" },
			{ key: "transfer_journal", value: "current journal bytes" },
			{ key: "transfer_kernel", value: "current kernel" },
			{ key: "transfer_prepare", value: "current preparation" },
			{ key: "transfer_state", value: "in_progress" },
		],
		archived: expect.arrayContaining([expect.objectContaining({ value: "old journal bytes" })]),
	});
});
it.for([
	"pending",
	"source-progress",
	"remote-progress",
	"receipt-progress",
	"wrong-identity",
	"publication-gap",
	"malformed-receipt",
])("refuses %s during read-only preparation", async (mode, test) => {
	expect(await fixture(test, mode)).toMatchObject({
		result: { _tag: "Failure" },
		targetSequence: [{ next: 1, published_through: 0 }],
		archived: [],
	});
});
it("refuses conflicting target settings without replacing them", async (test) => {
	expect(await fixture(test, "conflict")).toMatchObject({
		result: { _tag: "Failure" },
		controls: expect.arrayContaining([{ key: "transfer_state", value: "in_progress" }]),
		receipt: [{ value: "newer target bytes" }],
	});
});
