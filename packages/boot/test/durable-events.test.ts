import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
for (const scenario of ["lock", "fence", "generation", "source"])
	it(`durable boot ${scenario} transitions retain atomicity and replay boundaries`, async (test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-durable-events-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const result = await execute("bun", [join(import.meta.dirname, "fixtures/durable-events.ts"), root, scenario]);
		expect(result.stdout.trim()).toBe("PASS");
	});
