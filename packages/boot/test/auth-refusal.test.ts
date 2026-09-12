/* oxlint-disable effecttsgo/node-builtin-import */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("auth semantic refusal commits proof use, while mixed failures preserve every cause and roll back", async ({
	onTestFinished,
}) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-auth-refusal-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const result = await promisify(execFile)(
		"bun",
		[join(import.meta.dirname, "fixtures/auth-refusal.ts"), join(directory, "boot.db")],
		{ timeout: 15_000 },
	);
	expect(result.stdout).toContain("auth refusal causes preserved");
});
