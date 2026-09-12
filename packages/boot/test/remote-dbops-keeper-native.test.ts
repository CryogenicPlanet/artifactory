import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const root = process.env.COMMS_REMOTE_COPY_CONFIG_ROOT;
it.skipIf(!root)(
	"MySQL DbOps restores a locked native dump through the real keeper and hands it to the app",
	async (test) => {
		const data = await mkdtemp(join(tmpdir(), "comms-guarded-dbops-"));
		// Failure retains evidence/credentials for explicit recovery.
		const env = { ...process.env };
		delete env.COMMS_REMOTE_ROOT_CONFIG;
		delete env.GUARDIAN_TEST_ROOT;
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/remote-dbops-keeper.ts"), data],
			{
				timeout: 60000,
				env: {
					...env,
					COMMS_REMOTE_TEST_CONFIG: `${root}/mysql-dbops-app.json`,
					COMMS_REMOTE_BOOT_TEST_CONFIG: `${root}/mysql-dbops-boot.json`,
				},
			},
		);
		expect(result.stdout).toContain("GUARDED_DBOPS_COPY_VERIFIED");
		test.onTestFinished(() => rm(data, { recursive: true, force: true }));
	},
	70000,
);
