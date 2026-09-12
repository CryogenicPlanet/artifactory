import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it.for(["complete", "retry", "symlink", "conflict"])(
	"transfer activation receipt refuses uncertain authority: %s",
	async (mode, test) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-transfer-receipt-"));
		test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await execute("bun", [
			join(import.meta.dirname, "fixtures/store-transfer-receipt.ts"),
			directory,
			mode,
		]);
		expect(result.stdout).toContain(`Verified ${mode}`);
	},
);
