import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

for (const engine of ["sqlite", "pglite"])
	it(`${engine} applies repository migration ladders and preserves receipts and data on replay`, async () => {
		const { stdout } = await promisify(execFile)(
			"bun",
			[`${import.meta.dirname}/../fixtures/portable-migration-ladders.ts`, engine],
			{ timeout: 30000 },
		);
		expect(stdout).toContain("PORTABLE_LADDERS_VERIFIED");
	}, 40000);
