import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("keeps known refusals and retryable storage failures distinct from unknown and mixed defects", async () => {
	const { stdout } = await promisify(execFile)("bun", [`${import.meta.dirname}/fixtures/http-error-contracts.ts`]);
	expect(stdout).toContain("HTTP_ERROR_CONTRACTS_VERIFIED");
});
