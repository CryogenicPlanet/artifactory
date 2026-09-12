// These account-closure fixtures require an exclusive role pair: run with --maxWorkers=1.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_TEST_CONFIG || !process.env.COMMS_REMOTE_BOOT_TEST_CONFIG)(
	"root guardian closes borrowed app pools, retains boot SQL, and restarts only with exact closure inventory",
	async (test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-remote-runtime-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const run = () =>
			promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/remote-runtime.ts"), root], { timeout: 20000 });
		expect((await run()).stdout).toContain("REMOTE_RUNTIME_VERIFIED");
		expect((await run()).stdout).toContain("REMOTE_RUNTIME_VERIFIED");
		const owners = (await readdir(join(root, "remote-owners"))).filter((name) => name.endsWith(".json"));
		expect(owners).toHaveLength(2);
		await rm(join(root, "remote-owners", owners[0] ?? "missing"));
		await expect(run()).rejects.toThrow();
	},
	60000,
);
