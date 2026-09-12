import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
it("requires exact immutable keeper evidence without changing source bytes, then reconciles copied target rows", async () => {
	const result = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/transfer-child-closure.ts")]);
	expect(result.stdout.trim()).toBe("Read-only keeper closure and target reconciliation verified");
});
