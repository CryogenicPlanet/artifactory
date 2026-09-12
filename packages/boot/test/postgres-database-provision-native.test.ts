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
		expect(JSON.parse(result.stdout), result.stdout + result.stderr).toMatchObject({
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

it.skipIf(!configuration)(
	"PostgreSQL DbOps copies, rehearses and restores with restricted accounts without selecting or replacing the live database",
	async (test) => {
		const data = await mkdtemp(join(tmpdir(), "comms-dbops-factory-"));
		test.onTestFinished(() => rm(data, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/postgres-database-provision.ts"), configuration ?? "", data, "factory"],
			{ timeout: 30000 },
		);
		expect(JSON.parse(result.stdout), result.stdout + result.stderr).toMatchObject({
			_tag: "Success",
			value: { factory: true, bytes: true, rehearsed: 1, restored: 2, original: 2, retained: 1, unselected: true },
		});
	},
	40000,
);
