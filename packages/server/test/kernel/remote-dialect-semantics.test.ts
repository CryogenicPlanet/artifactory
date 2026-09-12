import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("executes shared transaction, read and publication visibility behavior", async () => {
	const result = await promisify(execFile)(
		"bun",
		[join(import.meta.dirname, "../fixtures/remote-dialect-semantics.ts")],
		{ timeout: 30000 },
	);
	expect(result.stdout).toContain("SHARED_STORE_VERIFIED");
}, 40000);
