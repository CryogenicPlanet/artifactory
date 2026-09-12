import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_BOOT_TEST_CONFIG)(
	"initializes remote boot history and preserves constraints, long values and durable data on reopen",
	async (test) => {
		const { stdout } = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/remote-schema.ts")], {
			timeout: 30000,
			env: process.env,
		});
		expect(stdout).toContain("boot native constraints, long values, binary, sequence and reopen durability passed");
		const root = await mkdtemp(join(tmpdir(), "comms-boot19-native-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const boot = join(root, "packages/boot");
		await cp(join(import.meta.dirname, "../src"), join(boot, "src"), { recursive: true });
		await mkdir(join(boot, "test/fixtures"), { recursive: true });
		await cp(join(import.meta.dirname, "fixtures/remote-schema.ts"), join(boot, "test/fixtures/remote-schema.ts"));
		await symlink(join(import.meta.dirname, "../node_modules"), join(boot, "node_modules"));
		const filename = join(boot, "src/remote-boot-schema.ts");
		const source = await readFile(filename, "utf8");
		const last = '"offline_store_transfer",';
		expect(source.split(last)).toHaveLength(2);
		await writeFile(filename, source.replace(last, ""));
		for (const mode of ["old", "current"]) {
			const script =
				mode === "old"
					? join(boot, "test/fixtures/remote-schema.ts")
					: join(import.meta.dirname, "fixtures/remote-schema.ts");
			const result = await promisify(execFile)("bun", [script, mode], { timeout: 10000, env: process.env });
			expect(result.stdout).toContain(`${mode} image refused both transfer markers without changing retained state`);
		}
	},
	// Fresh schema (30s), two refusal subprocesses (10s each), and source-copy overhead.
	60000,
);
