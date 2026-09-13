/* oxlint-disable effecttsgo/node-builtin-import */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

for (const scenario of ["origins", "code", "bound-origin", "zero-passkeys", "backfill"]) {
	test(`passkey code: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-passkey-code-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/passkey-code.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 20_000 },
		);
		expect(result.stdout).toContain("passkey code passed");
	}, 25_000);
}
