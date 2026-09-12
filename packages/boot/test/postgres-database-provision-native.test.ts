import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const configuration = process.env.COMMS_REMOTE_COPY_CONFIG_ROOT;
it.skipIf(!configuration)(
	"PostgreSQL resource provisioning protects boot tables and rejects cross-store access with scoped roles",
	async (test) => {
		const data = await mkdtemp(join(tmpdir(), "comms-dbops-provision-"));
		test.onTestFinished(() => rm(data, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/postgres-database-provision.ts"), configuration ?? "", data, "native"],
			{ timeout: 30000 },
		);
		expect(JSON.parse(result.stdout)).toMatchObject({
			_tag: "Success",
			value: {
				nativeLoad: true,
				protection: true,
				crossStoreDenied: true,
				negativePermission: true,
				cleanupRetried: true,
			},
		});
	},
	40000,
);
