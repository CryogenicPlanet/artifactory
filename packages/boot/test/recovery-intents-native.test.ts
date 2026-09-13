import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
for (const engine of ["sqlite", "pg", "mysql"])
	it.skipIf(engine !== "sqlite" && !process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR)(
		`${engine} returns numeric recovery admission counts`,
		async () => {
			const { stdout } = await execute("bun", [
				`${import.meta.dirname}/fixtures/recovery-intents-native.ts`,
				engine,
				process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR ?? "",
			]);
			expect(JSON.parse(stdout)).toEqual({ engine, passed: true });
		},
		30000,
	);
