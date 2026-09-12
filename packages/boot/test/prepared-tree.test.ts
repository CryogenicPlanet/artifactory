import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { copyPreparedTree } from "../src/prepared-tree.ts";

it("copies hardlinked dependencies into independent files and keeps internal links inside the copy", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-prepared-tree-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "installed");
	const target = join(root, "saved");
	await mkdir(join(source, "pkg"), { recursive: true });
	await writeFile(join(root, "package-cache"), "installed");
	await link(join(root, "package-cache"), join(source, "pkg/index.js"));
	await symlink(join(source, "pkg"), join(source, "alias"));
	await Effect.runPromise(copyPreparedTree(source, target).pipe(Effect.provide(BunServices.layer)));
	expect((await stat(join(target, "pkg/index.js"))).ino).not.toBe((await stat(join(root, "package-cache"))).ino);
	expect(await realpath(join(target, "alias"))).toBe(join(target, "pkg"));
	await writeFile(join(root, "package-cache"), "later install mutation");
	expect(await readFile(join(target, "alias/index.js"), "utf8")).toBe("installed");
	await writeFile(join(target, "alias/index.js"), "saved generation mutation");
	expect(await readFile(join(source, "pkg/index.js"), "utf8")).toBe("later install mutation");
});

it("rejects an installed package link that escapes its dependency tree", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-prepared-escape-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "installed");
	await mkdir(source);
	await writeFile(join(root, "outside"), "private bytes");
	await symlink("../outside", join(source, "escape"));
	const result = await Effect.runPromise(
		copyPreparedTree(source, join(root, "saved")).pipe(Effect.result, Effect.provide(BunServices.layer)),
	);
	expect(result).toMatchObject({
		_tag: "Failure",
		failure: { _tag: "SnapshotRejected", reason: "Prepared artifact link escapes its tree" },
	});
	await expect(realpath(join(root, "saved/escape"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("copies workspace dependencies independently and rejects links outside the disposable workspace", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-prepared-workspace-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const work = join(root, "work");
	const source = join(work, "node_modules");
	await mkdir(source, { recursive: true });
	await mkdir(join(work, "protocol"));
	await writeFile(join(work, "protocol/index.ts"), "original");
	await symlink("../protocol", join(source, "protocol"));
	const target = join(root, "saved");
	await Effect.runPromise(copyPreparedTree(source, target, work).pipe(Effect.provide(BunServices.layer)));
	expect(await realpath(join(target, "protocol"))).toBe(join(target, "protocol"));
	expect((await stat(join(target, "protocol/index.ts"))).ino).not.toBe(
		(await stat(join(work, "protocol/index.ts"))).ino,
	);
	await writeFile(join(work, "protocol/index.ts"), "build mutation");
	expect(await readFile(join(target, "protocol/index.ts"), "utf8")).toBe("original");
	await writeFile(join(root, "outside"), "private");
	await symlink("../../outside", join(work, "protocol/escape"));
	expect(
		await Effect.runPromise(
			copyPreparedTree(source, join(root, "refused"), work).pipe(Effect.result, Effect.provide(BunServices.layer)),
		),
	).toMatchObject({
		_tag: "Failure",
		failure: { _tag: "SnapshotRejected", reason: "Prepared artifact link escapes its tree" },
	});
});

it("refuses recursive workspace links", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-prepared-cycle-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const work = join(root, "work");
	await mkdir(join(work, "node_modules"), { recursive: true });
	await mkdir(join(work, "protocol"));
	await symlink("../protocol", join(work, "node_modules/protocol"));
	await symlink(".", join(work, "protocol/self"));
	expect(
		await Effect.runPromise(
			copyPreparedTree(join(work, "node_modules"), join(root, "refused"), work).pipe(
				Effect.result,
				Effect.provide(BunServices.layer),
			),
		),
	).toMatchObject({
		_tag: "Failure",
		failure: { _tag: "SnapshotRejected", reason: "Prepared workspace link is cyclic" },
	});
});
