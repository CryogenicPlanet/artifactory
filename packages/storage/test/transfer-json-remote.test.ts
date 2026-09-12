import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_TRANSFER_JSON_TEST_CONFIG)(
	"projects approved native JSON into SQLite without changing immutable text",
	async () => {
		const result = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/transfer-json-remote.ts")], {
			env: process.env,
		});
		expect(result.stdout).toMatch(/verified (pg|mysql) JSON projection/);
	},
	30000,
);
