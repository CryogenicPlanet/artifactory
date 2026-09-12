import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, type TestContext } from "vitest";

const fixture = async (test: TestContext, mode: string) => {
	const root = await mkdtemp(join(tmpdir(), "comms-inventory-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	return JSON.parse(
		(
			await promisify(execFile)("bun", [
				join(import.meta.dirname, "fixtures/transfer-inventory.ts"),
				join(root, "db"),
				mode,
			])
		).stdout,
	);
};
it("discovers custom tables, ordered composite keys, generated columns and rowid identities", async (test) => {
	const result = await fixture(test, "custom");
	expect(result).toMatchObject({
		_tag: "Success",
		success: {
			tables: [
				{
					name: "custom",
					primaryKey: ["id"],
					columns: [
						{ name: "id", identity: true, nullable: false },
						{ name: "a" },
						{ name: "b" },
						{ name: "payload", kind: "bytes", default: "X'00'" },
						{ name: "derived", generated: true },
					],
					foreignKeys: [
						{ columns: ["a", "b"], table: "parent", targets: ["a", "b"], onUpdate: "CASCADE", onDelete: "RESTRICT" },
					],
				},
				{ name: "parent", primaryKey: ["a", "b"] },
			],
		},
	});
});
it("excludes only validated FTS tables and catalog-identified shadows, retaining similarly named custom tables", async (test) => {
	const result = await fixture(test, "fts");
	expect(result).toMatchObject({
		_tag: "Success",
		success: { tables: [{ name: "messages" }, { name: "search_custom" }] },
	});
	expect(result.success.derived).toContain("search_data");
});
it.for(["untrusted-fts", "trigger", "view", "expression", "deferred", "match"])(
	"refuses unsupported %s without omitting data",
	async (mode, test) => {
		expect(await fixture(test, mode)).toMatchObject({
			_tag: "Failure",
			failure: { code: "transfer_object_unsupported" },
		});
	},
);

it("retains unsupported custom and ledger columns explicitly for coordinator preflight", async (test) => {
	const result = await fixture(test, "type");
	expect(result).toMatchObject({
		_tag: "Success",
		success: {
			tables: [
				{
					name: "boot_migrations",
					columns: [
						{ name: "migration_id" },
						{ name: "created_at", kind: "unsupported", declaration: "DATETIME" },
						{ name: "name" },
					],
				},
				{ name: "custom", columns: [{ name: "amount", kind: "unsupported", declaration: "DECIMAL(30,10)" }] },
			],
		},
	});
});
