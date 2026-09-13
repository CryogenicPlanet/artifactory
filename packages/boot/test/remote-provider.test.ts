import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("refuses provider operations without opening app SQL and preserves legacy intents", async () => {
	const { stdout } = await promisify(execFile)("bun", [`${import.meta.dirname}/fixtures/remote-provider.ts`]);
	expect(stdout).toContain("provider refusals verified");
});
