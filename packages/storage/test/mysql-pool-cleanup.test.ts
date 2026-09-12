import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

for (const mode of ["failure", "timeout"])
	it(`closes the actual mysql adapter pool after initial ${mode}`, async (test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-mysql-pool-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const modules = join(root, "node_modules");
		await mkdir(join(modules, "@effect"), { recursive: true });
		await cp(
			fileURLToPath(new URL("../", import.meta.resolve("@effect/sql-mysql2/MysqlClient"))),
			join(modules, "@effect/sql-mysql2"),
			{ recursive: true, dereference: true },
		);
		await symlink(resolve(import.meta.dirname, "../../../node_modules/effect"), join(modules, "effect"));
		await mkdir(join(modules, "mysql2"));
		await writeFile(
			join(modules, "mysql2/package.json"),
			JSON.stringify({ name: "mysql2", type: "module", exports: "./index.ts" }),
		);
		await cp(join(import.meta.dirname, "fixtures/mysql-failing-pool.ts"), join(modules, "mysql2/index.ts"));
		await cp(join(import.meta.dirname, "fixtures/mysql-pool-probe.ts"), join(root, "probe.ts"));
		const marker = join(root, "closed");
		await promisify(execFile)("bun", [join(root, "probe.ts")], {
			env: { ...process.env, POOL_PROBE: mode, POOL_CLOSED: marker },
			timeout: 10000,
		});
		expect(await readFile(marker, "utf8")).toBe("closed");
	}, 12000);
