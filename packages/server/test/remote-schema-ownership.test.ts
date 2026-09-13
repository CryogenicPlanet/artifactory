import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_SCHEMA_BOOT_CONFIG || !process.env.COMMS_REMOTE_SCHEMA_APP_CONFIG)(
	"migrates as the app role while preserving boot table and index ownership across reconnect",
	async () => {
		const { stdout } = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/remote-schema-ownership.ts")],
			{
				timeout: 30000,
				env: process.env,
			},
		);
		expect(stdout).toContain(
			"separate PostgreSQL roles preserve protected ownership, app migrations and reconnect data",
		);
	},
	35000,
);
