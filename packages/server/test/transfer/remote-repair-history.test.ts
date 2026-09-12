import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("archives failed repair history after successful repair without blocking the transferred destination", async () => {
	const { stdout } = await promisify(execFile)("bun", [
		`${import.meta.dirname}/../fixtures/transfer/remote-repair-history.ts`,
	]);
	expect(stdout.trim()).toBe('{"passed":true}');
});
