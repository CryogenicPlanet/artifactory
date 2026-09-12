import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("replays extension migrations without running registered handlers and refuses contextual factories", async () => {
	const result = await promisify(execFile)(
		"bun",
		[join(import.meta.dirname, "fixtures/transfer-extension-migrations.ts")],
		{ timeout: 10000 },
	);
	expect(result.stdout).toContain("TRANSFER_EXTENSION_REPLAY_VERIFIED");
}, 15000);
