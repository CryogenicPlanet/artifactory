import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it.for(["legacy", "variants", "namespaces", "operational", "malformed", "duplicate-conflict"])(
	"preserves durable receipt semantics through %s migration",
	async (mode) => {
		const result = await execute("bun", [new URL("../fixtures/idempotency.ts", import.meta.url).pathname, mode]);
		expect(result.stdout).toContain(`IDEMPOTENCY_${mode}_OK`);
	},
);
