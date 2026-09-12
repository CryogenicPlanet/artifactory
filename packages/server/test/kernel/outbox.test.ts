import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
it.for(["expiry", "operational", "backup", "pending", "incomplete", "bounded", "legacy-shipped", "restore-outbox"])(
	"retains publication and replay guarantees during %s cleanup",
	async (mode, test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-retention-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const result = await execute("bun", [join(import.meta.dirname, "../fixtures/outbox-retention.ts"), root, mode], {
			timeout: 10_000,
		});
		expect(result.stdout).toContain(`RETENTION_${mode}_OK`);
	},
);
