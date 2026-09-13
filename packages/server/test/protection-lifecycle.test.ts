import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
for (const engine of [
	"sqlite",
	"pglite",
	...(process.env.COMMS_PROTECTION_ENGINE ? [process.env.COMMS_PROTECTION_ENGINE] : []),
])
	it(`${engine} preserves protection ownership through explicit retirement, rename and migration replay`, async () => {
		const { stdout } = await promisify(execFile)(
			"bun",
			[`${import.meta.dirname}/fixtures/protection-lifecycle.ts`, engine],
			{ timeout: 30000 },
		);
		expect(stdout).toContain("PROTECTION_LIFECYCLE_VERIFIED");
	}, 35000);
