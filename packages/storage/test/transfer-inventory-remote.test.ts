import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_TRANSFER_TEST_CONFIG)(
	"inspects disposable native engine catalogs without omitting custom data",
	async () => {
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/transfer-inventory-remote.ts")],
			{ env: process.env },
		);
		expect(result.stdout).toMatch(/verified (pg|mysql) inventory/);
	},
	30000,
);
