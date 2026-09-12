import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("loads extension dependencies from its generation root and retains them after a stale lock rejection and source removal", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-package-install-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const execute = promisify(execFile);
	const source = join(root, "app");
	const packageDirectory = join(source, "ext/tool");
	await mkdir(packageDirectory, { recursive: true });
	const manifest = JSON.stringify({ name: "fixture", private: true, dependencies: { "is-number": "7.0.0" } });
	const lock = `{
 "lockfileVersion": 2, "configVersion": 1,
 "workspaces": { "": { "name": "fixture", "dependencies": { "is-number": "7.0.0" } } },
 "packages": { "is-number": ["is-number@7.0.0", "", {}, "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng=="] }
 }`;
	await writeFile(join(source, "package.json"), manifest);
	await writeFile(join(source, "bun.lock"), lock);
	// Undeclared package-local manifests do not add dependencies to the root install.
	await writeFile(
		join(packageDirectory, "package.json"),
		'{"name":"tool","type":"module","dependencies":{"is-number":"0.0.0"}}',
	);
	await writeFile(
		join(packageDirectory, "index.ts"),
		'import isNumber from "is-number"; console.log(isNumber("123"));',
	);
	const call = (snapshot: string) =>
		execute(
			"bun",
			[join(import.meta.dirname, "fixtures/extension-preparation.ts"), source, join(root, snapshot), root],
			{ timeout: 15000 },
		);
	expect((await call("good")).stdout).toContain('"prepared":true');
	expect((await execute("bun", [join(root, "good/ext/tool/index.ts")])).stdout.trim()).toBe("true");
	expect(await realpath(join(root, "good/node_modules"))).toBe(join(root, "good/node_modules"));
	await expect(realpath(join(root, "good/ext/tool/node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
	const cache = join(root, "cache/bun");
	const cachedPackage = (await readdir(cache)).find((name) => name.startsWith("is-number@7.0.0"));
	expect(cachedPackage).toBeDefined();
	const cached = join(cache, cachedPackage ?? "missing", "index.js");
	const original = await readFile(cached, "utf8");
	expect((await stat(cached)).ino).not.toBe((await stat(join(root, "good/node_modules/is-number/index.js"))).ino);
	await writeFile(join(root, "good/node_modules/is-number/index.js"), "module.exports = () => false");
	expect(await readFile(cached, "utf8")).toBe(original);
	expect((await call("again")).stdout).toContain('"prepared":true');
	expect((await execute("bun", [join(root, "again/ext/tool/index.ts")])).stdout.trim()).toBe("true");
	// Restore the original snapshot bytes for the independent restart assertions below.
	await writeFile(join(root, "good/node_modules/is-number/index.js"), original);
	await writeFile(join(source, "package.json"), manifest.replace("7.0.0", "6.0.0"));
	expect((await call("bad")).stdout).toContain('"prepared":false');
	await expect(realpath(join(root, "bad/node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(join(source, "package.json"), "utf8")).toBe(manifest.replace("7.0.0", "6.0.0"));
	expect(await readFile(join(source, "bun.lock"), "utf8")).toBe(lock);
	expect(await readdir(join(root, "cache"))).toEqual(["bun"]);
	await rm(source, { recursive: true });
	await rm(join(root, "cache"), { recursive: true });
	// A new process resolves the saved generation without source, install workspaces, or preparation.
	expect((await execute("bun", [join(root, "good/ext/tool/index.ts")])).stdout.trim()).toBe("true");
	expect(await readFile(join(root, "good/package.json"), "utf8")).toBe(manifest);
}, 20000);
