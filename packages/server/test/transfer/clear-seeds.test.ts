import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
const fixture = async (test: TestContext, mode: string) => {
	const root = await mkdtemp(join(tmpdir(), "comms-clear-seeds-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "../fixtures/transfer/clear-seeds.ts"),
		root,
		mode,
	]);
	return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(result.stdout);
};
it("clears app seed rows in reverse FK order, preserving kernel rows and ledgers through retry", async (test) => {
	expect(await fixture(test, "copy")).toMatchObject({
		result: { _tag: "Success" },
		parent: [],
		child: [],
		retained: [
			"retained store_identity",
			"retained kernel_writer",
			"retained outbox",
			"retained mutation_batches",
			"retained core_migrations",
			"retained migrations",
			"retained extension_migrations",
		],
	});
});
it.for(["journal", "retired", "complete", "mismatch", "missing-core", "ledger-plan", "rollback"])(
	"refuses %s without losing seed rows",
	async (mode, test) => {
		expect(await fixture(test, mode)).toMatchObject({
			result: { _tag: "Failure" },
			parent: [{ id: 1 }],
			child: [{ id: 2, parent: 1 }],
			retained: expect.arrayContaining(["retained store_identity", "retained outbox", "retained core_migrations"]),
		});
	},
);
