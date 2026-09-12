import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("replays frozen bundled schemas without a boot channel or lifecycle and refuses a stale epoch", async () => {
	const result = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/transfer-app-initialize.ts")], {
		timeout: 10000,
	});
	expect(result.stdout).toContain("TRANSFER_APP_SCHEMA_VERIFIED");
}, 15000);
