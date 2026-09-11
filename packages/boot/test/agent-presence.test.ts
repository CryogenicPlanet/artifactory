/* oxlint-disable effecttsgo/node-builtin-import */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("presence migrates, admits only valid credentials, aggregates rotations, and survives restart", async ({
	onTestFinished,
}) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-presence-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	for (const scenario of ["initial", "resume"]) {
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/agent-presence.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 20000 },
		);
		expect(result.stdout).toContain("presence passed");
	}
}, 25000);
