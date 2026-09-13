import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
for (const engine of [
	"sqlite",
	"pglite",
	...(process.env.COMMS_MENTION_UPGRADE_ENGINE ? [process.env.COMMS_MENTION_UPGRADE_ENGINE] : []),
])
	it(`${engine} rebuilds mention images transactionally without rewriting prior data or history`, async () => {
		const { stdout } = await promisify(execFile)(
			"bun",
			[`${import.meta.dirname}/fixtures/mention-upgrade.ts`, engine],
			{ timeout: 30000 },
		);
		expect(stdout).toContain("MENTION_UPGRADE_VERIFIED");
	}, 35000);
