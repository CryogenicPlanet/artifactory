import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

for (const engine of process.env.COMMS_TEST_ENGINE ? [process.env.COMMS_TEST_ENGINE] : ["sqlite", "pglite"])
	for (const mode of ["pending", "incomplete", "bounded"])
		it(`${engine} preserves ${mode} outbox cleanup guarantees`, async () => {
			const { stdout } = await promisify(execFile)(
				"bun",
				[join(import.meta.dirname, "../fixtures/portable-outbox.ts"), mode],
				{
					timeout: 30000,
					env: { ...process.env, COMMS_TEST_ENGINE: engine },
				},
			);
			expect(stdout).toContain(`PORTABLE_OUTBOX_${mode}_VERIFIED`);
		}, 35000);
