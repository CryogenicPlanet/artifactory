import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
it.skipIf(!process.env.COMMS_UNACCENT_SOURCE_CONFIG || !process.env.COMMS_UNACCENT_TARGET_CONFIG)(
	"transfers folded/plain PostgreSQL search projections without copying derived bytes",
	async () => {
		const { stdout } = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/transfer-unaccent.ts")], {
			env: process.env,
			timeout: 30000,
		});
		expect(stdout).toContain("Unaccent transfer catalog and regenerated copy passed");
	},
	35000,
);
