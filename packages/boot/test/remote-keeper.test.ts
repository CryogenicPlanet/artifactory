// These account-closure fixtures require an exclusive role pair: run with --maxWorkers=1.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

for (const mode of ["eof", "kill", "reject"])
	it.skipIf(!process.env.COMMS_REMOTE_TEST_CONFIG || !process.env.COMMS_REMOTE_BOOT_TEST_CONFIG)(
		`remote keeper proves account closure before receipt after ${mode}`,
		async (test) => {
			const root = await mkdtemp(join(tmpdir(), "comms-remote-keeper-"));
			test.onTestFinished(() => rm(root, { recursive: true, force: true }));
			const result = await promisify(execFile)(
				"bun",
				[join(import.meta.dirname, "fixtures/remote-keeper.ts"), root, mode],
				{ timeout: 25000 },
			);
			expect(result.stdout).toContain("REMOTE_KEEPER_VERIFIED");
		},
		30000,
	);
