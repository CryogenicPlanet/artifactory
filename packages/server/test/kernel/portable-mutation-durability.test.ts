import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
for (const engine of process.env.COMMS_TEST_ENGINE ? [process.env.COMMS_TEST_ENGINE] : ["sqlite", "pglite"])
	it(`preserves reservation, publication and durable retry on ${engine}`, async () => {
		const result = await execute("bun", [`${import.meta.dirname}/../fixtures/portable-mutation-durability.ts`], {
			env: { ...process.env, COMMS_TEST_ENGINE: engine },
			timeout: 20000,
		});
		expect(result.stdout).toContain(`PORTABLE_MUTATION_VERIFIED ${engine}`);
	}, 25000);
