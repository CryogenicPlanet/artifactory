import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";

it("fences extension migrations, commits the schema and ledger atomically, and rejects changed or partial replays", async () => {
	const result = await promisify(execFile)("bun", [join(import.meta.dirname, "../fixtures/extension-migrations.ts")]);
	expect(result.stdout).toContain("EXTENSION_MIGRATIONS_ATOMIC");
});
