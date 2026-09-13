import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_DIALECT_CONFIG)(
	"executes native dialect fragments, topic moves, read marks, unread counts and SQL publication guards",
	async () => {
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "../fixtures/remote-dialect-semantics.ts")],
			{ timeout: 30000 },
		);
		expect(result.stdout).toContain("REMOTE_DIALECT_VERIFIED");
	},
	40000,
);
