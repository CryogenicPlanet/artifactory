import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// Explicit native selection runs exactly that disposable group; ordinary CI runs both local dialects.
for (const engine of process.env.COMMS_TEST_ENGINE ? [process.env.COMMS_TEST_ENGINE] : ["sqlite", "pglite"])
	it(`${engine} executes shared transaction, read and publication visibility behavior`, async () => {
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "../fixtures/remote-dialect-semantics.ts")],
			{ timeout: 30000, env: { ...process.env, COMMS_TEST_ENGINE: engine } },
		);
		expect(result.stdout).toContain("SHARED_STORE_VERIFIED");
	}, 40000);
