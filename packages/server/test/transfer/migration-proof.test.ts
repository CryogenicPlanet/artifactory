import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, type TestContext } from "vitest";
const fixture = async (test: TestContext) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-migration-proof-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "transfers", "12345678-1234-4234-8234-123456789abc");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return {
		root,
		directory,
		file: join(directory, "migration-proof.json"),
		run: async (action: string) => {
			const result = await promisify(execFile)("bun", [
				join(import.meta.dirname, "../fixtures/transfer/migration-proof.ts"),
				root,
				action,
			]);
			return result.stdout;
		},
	};
};
it("persists private proof, reads back and accepts exact retry without replacing bytes", async (test) => {
	const f = await fixture(test);
	expect(await f.run("read")).toContain('"_tag":"Success"');
	expect(await f.run("write")).toContain('"_tag":"Success"');
	const before = await readFile(f.file, "utf8");
	expect((await stat(f.file)).mode & 0o777).toBe(0o600);
	expect(await f.run("read")).toContain('"epoch":"' + "a".repeat(64) + '"');
	expect(await f.run("read")).toContain('"sourceLegacyChecksum":"' + "c".repeat(64) + '"');
	expect(await f.run("write")).toContain('"_tag":"Success"');
	expect(await f.run("conflict")).toContain('"_tag":"Failure"');
	expect(await readFile(f.file, "utf8")).toBe(before);
});
it("refuses invalid safety bindings and leaves partial temporary files untouched", async (test) => {
	const f = await fixture(test);
	expect(await f.run("invalid")).toContain('"_tag":"Failure"');
	await writeFile(f.file + ".next", "partial", { mode: 0o600 });
	expect(await f.run("write")).toContain('"_tag":"Failure"');
	expect(await f.run("read")).toContain('"_tag":"Failure"');
	expect(await readFile(f.file + ".next", "utf8")).toBe("partial");
});
it("refuses symlink, broad permissions, oversized and excess-field proofs", async (test) => {
	const f = await fixture(test);
	await f.run("write");
	const original = await readFile(f.file, "utf8");
	await chmod(f.file, 0o644);
	expect(await f.run("read")).toContain('"_tag":"Failure"');
	await chmod(f.file, 0o600);
	await writeFile(f.file, original.replace("{", '{"extra":true,'));
	expect(await f.run("read")).toContain('"_tag":"Failure"');
	await writeFile(f.file, original.replace("c".repeat(64), "c".repeat(63)));
	expect(await f.run("read")).toContain('"_tag":"Failure"');
	await writeFile(f.file, " ".repeat(1024 * 1024 + 1));
	expect(await f.run("read")).toContain('"_tag":"Failure"');
	await rm(f.file);
	await symlink(join(f.root, "absent"), f.file);
	expect(await f.run("write")).toContain('"_tag":"Failure"');
});

it("accepts relative generation entries and rejects escaping or ambiguous entries", async (test) => {
	const f = await fixture(test);
	for (const entry of [
		"../server.ts",
		"/server.ts",
		"",
		"./server.ts",
		"sub//server.ts",
		"sub/../server.ts",
		"sub\\server.ts",
		"sub/\nserver.ts",
	])
		expect(await f.run(`entry:${entry}`)).toContain('"_tag":"Failure"');
	expect(await f.run("entry:sub/server.ts")).toContain('"_tag":"Success"');
	expect(await f.run("read")).toContain('"entry_file":"sub/server.ts"');
});
