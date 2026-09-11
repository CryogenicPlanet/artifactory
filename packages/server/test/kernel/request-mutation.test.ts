import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
it("finishes admitted request writes across freeze without extending a revoked lease or bypassing scopes and transactions", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-request-mutation-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await execute("bun", [join(import.meta.dirname, "../fixtures/request-mutation.ts"), root]);
	expect(result.stdout).toContain("REQUEST_MUTATION_VERIFIED");
});
