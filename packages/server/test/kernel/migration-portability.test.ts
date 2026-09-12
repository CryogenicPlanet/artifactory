import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";

it.for(["rehearsal", "candidate"])(
	"observes new migration branches only in %s and keeps replay and failure quiet",
	async (state) => {
		const result = await promisify(execFile)("bun", [
			join(import.meta.dirname, "../fixtures/migration-portability.ts"),
			state,
		]);
		expect(result.stdout).toContain("MIGRATION_ADVISORIES_VERIFIED");
	},
);
