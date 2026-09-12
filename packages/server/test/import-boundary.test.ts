import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("permits boot imports only from the launcher and explicit integration fixtures", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-import-boundary-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const repository = resolve(import.meta.dirname, "../../..");
	await mkdir(join(root, "scripts"));
	await mkdir(join(root, "packages/boot/src"), { recursive: true });
	await writeFile(join(root, "packages/boot/src/app-recovery.ts"), "");
	await cp(join(repository, "scripts/check-invariants.ts"), join(root, "scripts/check-invariants.ts"));
	await symlink(join(repository, "node_modules"), join(root, "node_modules"));
	const execute = promisify(execFile);
	for (const [file, allowed] of [
		["src/start.ts", true],
		["src/server.ts", false],
		["src/ext/example.ts", false],
		["test/fixtures/recovery.ts", true],
	] as const) {
		const filename = join(root, "packages/server", file);
		await mkdir(resolve(filename, ".."), { recursive: true });
		await writeFile(filename, 'import { boot } from "@comms/boot";\n');
		const result = await execute("bun", [join(root, "scripts/check-invariants.ts")]).then(
			({ stdout }) => ({ ok: true, output: stdout }),
			(error: unknown) => ({ ok: false, output: String(error) }),
		);
		expect(result.ok, result.output).toBe(allowed);
		if (!allowed) expect(result.output).toContain("unsupported workspace import: @comms/boot");
		await rm(filename);
	}
});
