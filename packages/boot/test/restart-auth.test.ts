/* oxlint-disable effecttsgo/node-builtin-import */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

for (const scenario of [
	"binding",
	"verification",
	"session-expiry",
	"session-revocation",
	"transaction",
	"concurrency",
]) {
	test(`signed restart authorization: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-restart-auth-test-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/restart-auth.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 20_000 },
		);
		expect(result.stdout).toContain("signed restart authorization passed");
	}, 25_000);
}
