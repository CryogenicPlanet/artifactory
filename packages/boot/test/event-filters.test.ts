import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("uses indexed event filters with exclusive cursors, privacy and literal subtree boundaries", async () => {
	const { stdout } = await promisify(execFile)("bun", [`${import.meta.dirname}/fixtures/event-filters.ts`]);
	expect(stdout).toContain("event filters and indexes verified");
});
