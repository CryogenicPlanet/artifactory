import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
it.for(["idle", "coalesced", "retry", "mutation", "backlog"])("runs the local publication pump: %s", async (mode) => {
	const result = await execute("bun", [join(import.meta.dirname, "../fixtures/publication-relay.ts"), mode], {
		timeout: 10000,
	});
	expect(result.stdout).toContain(`PUBLICATION_RELAY_${mode}_OK`);
});
