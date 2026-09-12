import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_MYSQL_SEARCH_CONFIG)(
	"native MySQL search ANDs indexed terms and returns a superset for stopwords",
	async () => {
		const { stdout } = await promisify(execFile)("bun", [join(import.meta.dirname, "../../fixtures/mysql-search.ts")], {
			timeout: 15000,
		});
		expect(stdout).toContain("MYSQL_SEARCH_VERIFIED");
	},
	20000,
);
