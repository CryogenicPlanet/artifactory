import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_COPY_CONFIG_ROOT)(
	"MySQL native provisioner proves resource ownership, scoped grants and cleanup",
	async () => {
		const root = process.env.COMMS_REMOTE_COPY_CONFIG_ROOT;
		if (!root) throw Error("Missing native config root");
		const directory = await mkdtemp(join(tmpdir(), "comms-mysql-provision-"));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/mysql-provision-native.ts"), root, directory],
			{ timeout: 30000 },
		);
		expect(JSON.parse(result.stdout)).toMatchObject({
			_tag: "Success",
			value: { created: true, scoped: true, readOnlyDump: true, hiddenMetadataRefused: true, cleaned: true },
		});
		await rm(directory, { recursive: true, force: true });
	},
);
