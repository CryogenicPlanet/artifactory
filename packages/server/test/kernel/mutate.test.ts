import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
it.for([
	"receipt",
	"variable-batch",
	"reserve-lost",
	"caught-reserve",
	"caught-second-reserve",
	"event-mismatch",
	"commit-defect",
	"poisoned-commit-defect",
	"relay-commit-defect",
	"rollback-defect",
	"health-rollback-defect",
	"probe-mutation-rollback-defect",
	"recursive",
	"probe",
	"stale-epoch",
	"append-lost",
	"cleanup-failed",
])("preserves shared mutation durability under %s", async (mode, test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-mutate-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await execute("bun", [join(import.meta.dirname, "../fixtures/mutation-protocol.ts"), root, mode], {
		timeout: 10_000,
	});
	expect(result.stdout).toContain("MUTATION_VERIFIED");
});

it("replays acknowledged work after process death before outbox cleanup", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-cleanup-crash-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const fixture = join(import.meta.dirname, "../fixtures/mutation-protocol.ts");
	await expect(execute("bun", [fixture, root, "crash-after-ack"], { timeout: 10_000 })).rejects.toMatchObject({
		code: 72,
	});
	const result = await execute("bun", [fixture, root, "restart-after-ack"], { timeout: 10_000 });
	expect(result.stdout).toContain("MUTATION_VERIFIED");
});
