import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("receives a completed real SQLite copy after the former twenty-second caller deadline", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-backup-budget-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	for (const name of ["boot", "server"]) {
		const source = join(import.meta.dirname, `../../${name}`);
		const target = join(root, "packages", name);
		await cp(join(source, "src"), join(target, "src"), { recursive: true });
		await symlink(join(source, "node_modules"), join(target, "node_modules"));
	}
	const fixtures = join(root, "packages/server/test/fixtures");
	await mkdir(fixtures, { recursive: true });
	const entry = join(fixtures, "backup-copy-budget.ts");
	await cp(join(import.meta.dirname, "fixtures/backup-copy-budget.ts"), entry);
	const worker = join(root, "packages/boot/src/sqlite-copy-worker.ts");
	const source = await readFile(worker, "utf8");
	const anchor = "yield* sql`VACUUM INTO ${config.destination}`;";
	expect(source.split(anchor)).toHaveLength(2);
	await writeFile(worker, source.replace(anchor, `yield* Effect.sleep("21 seconds");\n${anchor}`));
	const { stdout } = await promisify(execFile)("bun", [entry, root]);
	expect(stdout.trim()).toBe("copied-and-acknowledged");
}, 40000);
