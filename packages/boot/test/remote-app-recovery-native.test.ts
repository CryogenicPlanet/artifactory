import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";
const execute = promisify(execFile);
for (const engine of ["pg", "mysql"])
	it.skipIf(!process.env.COMMS_RECOVERY_NATIVE_CONFIG_DIR)(
		`${engine} commits fences despite broken evidence and refuses missing, foreign or retired app identities`,
		async () => {
			const directory = process.env.COMMS_RECOVERY_NATIVE_CONFIG_DIR;
			if (!directory) throw new Error("Missing disposable database configuration");
			const { stdout } = await execute("bun", [
				`${import.meta.dirname}/fixtures/remote-app-recovery-native.ts`,
				`${directory}/${engine}-comms_recovery_app.json`,
				`${directory}/${engine}-comms_recovery_boot.json`,
			]);
			expect(Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout)).toEqual({ engine, passed: 7 });
		},
		30000,
	);
