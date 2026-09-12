import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const fixture = join(import.meta.dirname, "fixtures/transfer-kernel-initialize.ts");
for (const engine of ["sqlite", "pg", "mysql"] as const) {
	it.skipIf(engine !== "sqlite" && !process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR)(
		`${engine} transfer reserves identity and resumes committed schema without adopting foreign objects`,
		{ timeout: 60000 },
		async (test) => {
			const local = await realpath(await mkdtemp("/tmp/comms-transfer-kernel-"));
			test.onTestFinished(() => rm(local, { recursive: true, force: true }));
			const directory = engine === "sqlite" ? local : process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR;
			if (!directory) throw new Error("Missing private initializer configuration");
			const run = async (mode: string, script = fixture) =>
				JSON.parse((await execute("bun", [script, directory, engine, mode])).stdout);
			await run("reset");
			expect(await run("missing-reservation")).toMatchObject({ ok: false, tables: [] });
			expect(await run("foreign")).toMatchObject({ ok: false, tables: ["intruder"] });
			await run("reset");
			const boot = join(local, "packages/boot");
			await cp(join(import.meta.dirname, "../src"), join(boot, "src"), { recursive: true });
			await mkdir(join(boot, "test/fixtures"), { recursive: true });
			await cp(fixture, join(boot, "test/fixtures/transfer-kernel-initialize.ts"));
			await symlink(join(import.meta.dirname, "../node_modules"), join(boot, "node_modules"));
			const target = join(boot, "src", engine === "sqlite" ? "transfer-kernel-initialize.ts" : "app-kernel-replay.ts");
			const source = await readFile(target, "utf8");
			const needle =
				engine === "sqlite"
					? "return yield* save({ ...saved, seeded: true });"
					: "progress = yield* checkpoint(index, operation.name, null);";
			expect(source.split(needle)).toHaveLength(2);
			const kill =
				engine === "sqlite"
					? 'process.kill(process.pid, "SIGKILL");'
					: `if (index === ${engine === "mysql" ? 6 : 0}) process.kill(process.pid, "SIGKILL");`;
			await writeFile(target, source.replace(needle, `${kill}\n${needle}`));
			await expect(run("initialize", join(boot, "test/fixtures/transfer-kernel-initialize.ts"))).rejects.toMatchObject({
				signal: "SIGKILL",
			});
			expect(await run("wrong-selection")).toMatchObject({ ok: false });
			expect(await run("wrong-epoch")).toMatchObject({ ok: false });
			const resumed = await run("initialize");
			expect(resumed).toMatchObject({
				ok: true,
				identities: [{ store_id: "11111111-1111-4111-8111-111111111111", initialized_at: 123456 }],
			});
			expect(JSON.parse(resumed.progress)).toMatchObject({ seeded: true, active: null, epoch: "transfer-new-epoch" });
			expect(await run("initialize")).toMatchObject({ ok: true });
			expect(await run("wrong-opened-app")).toMatchObject({ ok: false });
		},
	);
}
