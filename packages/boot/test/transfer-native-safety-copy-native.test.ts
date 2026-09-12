import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const configRoot = process.env.COMMS_TRANSFER_SAFETY_CONFIG_ROOT;
for (const engine of ["pg", "mysql"] as const)
	it.skipIf(!configRoot)(
		`${engine} recovers a provisioned dump principal and captures both unchanged stores through native keepers`,
		async (test) => {
			const data = await realpath(await mkdtemp(join(tmpdir(), `comms-transfer-safety-${engine}-`)));
			// Failure retains the journal and artifacts for explicit principal recovery.
			const env = { ...process.env };
			delete env.COMMS_REMOTE_ROOT_CONFIG;
			delete env.TRANSFER_SAFETY_ROOT;
			delete env.TRANSFER_SAFETY_PHASE;
			for (const phase of ["provision", "recover-capture"]) {
				const result = await promisify(execFile)(
					"bun",
					[join(import.meta.dirname, "fixtures/transfer-native-safety-copy.ts"), data, phase],
					{
						timeout: 90000,
						env: {
							...env,
							COMMS_REMOTE_TEST_CONFIG: `${configRoot}/${engine}-offline-source-app.json`,
							COMMS_REMOTE_BOOT_TEST_CONFIG: `${configRoot}/${engine}-offline-source-boot.json`,
						},
					},
				);
				expect(result.stdout).toContain(`NATIVE_TRANSFER_SAFETY_${phase}_VERIFIED`);
			}
			test.onTestFinished(() => rm(data, { recursive: true, force: true }));
		},
		190000,
	);
