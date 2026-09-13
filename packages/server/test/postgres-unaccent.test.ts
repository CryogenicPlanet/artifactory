import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
for (const mode of ["fresh", "upgrade", "denied"] as const) {
	const config = process.env[`COMMS_UNACCENT_${mode.toUpperCase()}_CONFIG`];
	it.skipIf(!config)(
		`PostgreSQL unaccent ${mode} preserves published images and schema history`,
		async () => {
			const { stdout } = await promisify(execFile)(
				"bun",
				[join(import.meta.dirname, "fixtures/postgres-unaccent.ts")],
				{ env: { ...process.env, COMMS_UNACCENT_CONFIG: config, COMMS_UNACCENT_MODE: mode }, timeout: 30000 },
			);
			expect(stdout).toContain(`PostgreSQL unaccent ${mode}: passed`);
			if (mode === "denied") expect(stdout).toContain("PostgreSQL search diacritic folding unavailable");
		},
		35000,
	);
}
