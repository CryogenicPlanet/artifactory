import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";
const execute = promisify(execFile);
for (const engine of ["pg", "mysql"])
	it.skipIf(!process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR)(
		`${engine} detects legacy tables without reading or changing evidence`,
		async () => {
			const directory = process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR;
			if (!directory) throw new Error("Missing disposable configurations");
			const { stdout } = await execute("bun", [
				`${import.meta.dirname}/fixtures/legacy-topic-moves-native.ts`,
				directory,
				engine,
			]);
			expect(Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout)).toEqual({ engine, passed: true });
		},
		30000,
	);
