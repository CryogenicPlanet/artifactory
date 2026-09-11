import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";

async function fixture(test: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-browse-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "app"));
	await mkdir(join(root, "pages"));
	await writeFile(join(root, "app/main.ts"), "committed");
	const execute = promisify(execFile);
	const call = async (path: string, extra: object = {}) =>
		Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
			(
				await execute("bun", [
					join(import.meta.dirname, "fixtures/source-store.ts"),
					root,
					JSON.stringify({ op: "browse", path, ...extra }),
				])
			).stdout.trim(),
		);
	return { root, call };
}

it("lists sorted committed entries, empty directories and non-directory targets", async (test) => {
	const { root, call } = await fixture(test);
	await mkdir(join(root, "app/empty"));
	await writeFile(join(root, "app/a b&.ts"), "code");
	expect(await call("app")).toEqual([
		{ name: "a b&.ts", type: "file" },
		{ name: "empty", type: "directory" },
		{ name: "main.ts", type: "file" },
	]);
	expect(await call("app/empty")).toEqual([]);
	expect(await call("pages")).toEqual([]);
	expect(await call("app/main.ts")).toBeNull();
});

it("isolates staged additions, deletions and virtual directories to the holder", async (test) => {
	const { root, call } = await fixture(test);
	await mkdir(join(root, "app/empty"));
	await writeFile(join(root, "app/a b&.ts"), "code");

	expect(
		await call("app", {
			holder: true,
			writes: [
				{ path: "app/main.ts", content: null },
				{ path: "app/new/deep/created.ts", content: "staged" },
			],
		}),
	).toEqual([
		{ name: "a b&.ts", type: "file" },
		{ name: "empty", type: "directory" },
		{ name: "new", type: "directory" },
	]);
	expect(await call("app/new", { holder: true })).toEqual([{ name: "deep", type: "directory" }]);
	expect(await call("app/new/deep", { holder: true })).toEqual([{ name: "created.ts", type: "file" }]);
	expect(await call("app/new")).toBeNull();
	expect(await call("app")).toContainEqual({ name: "main.ts", type: "file" });
	expect(
		await call("app/new", { holder: true, writes: [{ path: "app/new/deep/created.ts", content: null }] }),
	).toBeNull();
});

it("omits unsafe children and refuses traversal, root links, dangling links, generated trees and journal names", async (test) => {
	const { root, call } = await fixture(test);
	await mkdir(join(root, "outside"));
	await writeFile(join(root, "outside/secret"), "private");
	await symlink(join(root, "outside"), join(root, "app/link"));
	await symlink(join(root, "missing"), join(root, "app/dangling"));
	await mkdir(join(root, "app/node_modules"));
	await mkdir(join(root, "app/.vite"));
	await mkdir(join(root, "app/ui/dist"), { recursive: true });
	await writeFile(join(root, "app/.comms-journal.tmp"), "partial bytes");
	expect(await call("app")).toEqual([
		{ name: "main.ts", type: "file" },
		{ name: "ui", type: "directory" },
	]);
	expect(await call("app/ui")).toEqual([]);
	for (const path of [
		"app/../outside",
		"app//main.ts",
		"boot.db",
		"app/link",
		"app/dangling",
		"app/link/secret",
		"app/node_modules",
		"app/.vite",
		"app/ui/dist",
		"app/.comms-journal.tmp",
		"app/\\outside",
	])
		expect(await call(path)).toMatchObject({ error: "invalid_path" });
	await rm(join(root, "app"), { recursive: true });
	await symlink(join(root, "outside"), join(root, "app"));
	expect(await call("app")).toMatchObject({ error: "invalid_path" });
}, 15000);
