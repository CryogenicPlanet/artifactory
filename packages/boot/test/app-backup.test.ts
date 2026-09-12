import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { TestContext } from "vitest";

async function run(test: TestContext, operation: "restore" | "bootstrap" | "foreign") {
	const root = await mkdtemp(join(tmpdir(), "comms-backup-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/app-backup.ts"),
		root,
		operation,
	]);
	const value: unknown = JSON.parse(result.stdout);
	return value;
}

describe("app database backup", () => {
	it("refuses foreign-engine artifacts before reading files or changing the live identity", async (test) => {
		expect(await run(test, "foreign")).toEqual(["backup_engine_mismatch", "backup_engine_mismatch"]);
	});
	it("restores the saved data after every old SQLite handle has closed", async (test) => {
		expect(await run(test, "restore")).toEqual([{ value: "before backup" }]);
	});
	it("installs the clone writer epoch without inspecting editable domain tables", async (test) => {
		expect(await run(test, "bootstrap")).toEqual({ epoch: { epoch: "rehearsal" }, prepared: "Success" });
	});
});
