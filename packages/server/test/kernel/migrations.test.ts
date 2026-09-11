import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it("orders TS migrations, commits once, rolls back the whole pending batch and refuses duplicate IDs or stale writers", async () => {
	const result = await execute("bun", [join(import.meta.dirname, "../fixtures/migrations.ts")]);
	expect(result.stdout).toContain("MIGRATIONS_ATOMIC");
});
