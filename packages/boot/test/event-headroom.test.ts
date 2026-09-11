import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("refuses new reservations below headroom while retaining replay, publication, abort and boot writes", async () => {
	const { stdout } = await promisify(execFile)("bun", [`${import.meta.dirname}/fixtures/event-headroom.ts`]);
	expect(stdout).toContain("reservation headroom verified");
});
