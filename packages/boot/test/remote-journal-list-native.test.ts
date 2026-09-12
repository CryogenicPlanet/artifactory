import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
for (const engine of ["pg", "mysql"])
	it.skipIf(!process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR)(
		`${engine} lists exact remote journal keys and refuses malformed records`,
		async () => {
			const { stdout } = await execute("bun", [
				`${import.meta.dirname}/fixtures/remote-journal-list-native.ts`,
				engine,
				process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR ?? "",
			]);
			expect(JSON.parse(stdout)).toEqual({ engine, passed: true });
		},
		30000,
	);
