import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);

it("ignores linked source and helper directories while leaving unsafe package entries as optional failures", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-package-discovery-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "ext");
	await mkdir(directory);
	await writeFile(join(root, "external.ts"), "throw Error('not imported')");
	await symlink(join(root, "external.ts"), join(directory, "linked.ts"));
	await symlink(join(root, "missing.ts"), join(directory, "dangling.ts"));
	for (const name of ["linked-entry", "directory-entry", "core.ts", "helpers.js", "array-manifest"])
		await mkdir(join(directory, name));
	for (const name of ["linked-entry", "directory-entry", "core.ts"])
		await writeFile(join(directory, name, "package.json"), "{}");
	await writeFile(join(directory, "array-manifest/package.json"), "[]");
	await writeFile(join(directory, "array-manifest/index.ts"), "export default () => {};");
	await symlink(join(root, "external.ts"), join(directory, "linked-entry/index.ts"));
	await mkdir(join(directory, "directory-entry/index.ts"));
	await writeFile(join(directory, "core.ts/index.ts"), "export default () => {};");
	await writeFile(join(directory, "a-first.ts"), "export default () => {};");
	await writeFile(join(directory, "core.js"), "export default () => {};");
	await symlink(join(directory, "core.ts"), join(directory, "linked-package"));
	const result = await execute("bun", [join(import.meta.dirname, "../fixtures/extension-discovery.ts")], {
		env: { ...process.env, EXTENSION_DIRECTORY: directory },
	});
	expect(JSON.parse(result.stdout)).toEqual([
		{ name: "core.js", valid: true },
		{ name: "a-first.ts", valid: true },
		{ name: "array-manifest", valid: false },
		{ name: "core.ts", valid: true },
		{ name: "directory-entry", valid: false },
		{ name: "linked-entry", valid: false },
	]);
});
