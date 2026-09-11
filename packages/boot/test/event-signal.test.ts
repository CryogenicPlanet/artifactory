import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("wakes on durable publication and closes existing and future waits during shutdown", async () => {
	const { stdout } = await promisify(execFile)("bun", [`${import.meta.dirname}/fixtures/event-signal.ts`]);
	expect(JSON.parse(stdout)).toEqual([1, 3, 3]);
});
