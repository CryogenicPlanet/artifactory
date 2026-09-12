import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
it("closes source inspections and captures or verifies safety receipts without changing source bytes", async () => {
	const { stdout } = await promisify(execFile)("bun", [
		`${import.meta.dirname}/../fixtures/transfer/source-session.ts`,
	]);
	expect(stdout.trim()).toBe('{"passed":true}');
});

it("reads and backs up committed WAL bytes left by a killed source writer", async () => {
	const { stdout } = await promisify(execFile)("bun", [
		`${import.meta.dirname}/../fixtures/transfer/source-session.ts`,
		"wal",
	]);
	expect(stdout.trim()).toBe('{"passed":true}');
});
