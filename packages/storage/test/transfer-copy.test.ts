import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";

const fixture = async (test: TestContext, mode: string) => {
	const root = await mkdtemp(join(tmpdir(), "comms-transfer-copy-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/transfer-copy.ts"), root, mode]);
	return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(result.stdout);
};

it("copies across multiple reader chunks without changing integers, binary bytes, Unicode or JSON", async (test) => {
	expect(await fixture(test, "copy")).toMatchObject({
		result: { _tag: "Success", success: { rows: 513, identities: [{ column: "id", maximum: "513" }] } },
		count: 513,
		manifestMatches: true,
		samplesMatch: true,
		corruptionDetected: true,
	});
});

it("refuses a late null before writing any row to a nonnullable destination", async (test) => {
	expect(await fixture(test, "null-target")).toMatchObject({ result: { _tag: "Failure" }, count: 0 });
});

it("refuses a stale expected digest before writing any target data", async (test) => {
	expect(await fixture(test, "wrong-digest")).toMatchObject({ result: { _tag: "Failure" }, count: 0 });
});

it("refuses a nonempty destination without replacing or deleting existing rows", async (test) => {
	expect(await fixture(test, "nonempty")).toMatchObject({
		result: { _tag: "Failure" },
		count: 1,
		retained: [{ id: "999", body: "existing target row", payload: "09" }],
	});
});

it.for(["no-key", "duplicate-key", "null-key"])(
	"refuses %s instead of scanning an ambiguous row order",
	async (mode, test) => {
		expect(await fixture(test, mode)).toMatchObject({ result: { _tag: "Failure" }, count: 0 });
	},
);
