import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("selects durable source identity and refuses unfinished publication, ownership and recovery evidence without mutation", async () => {
	const { stdout } = await promisify(execFile)("bun", [
		`${import.meta.dirname}/../fixtures/transfer/source-preflight.ts`,
	]);
	expect(stdout.trim()).toBe('{"passed":true}');
});
