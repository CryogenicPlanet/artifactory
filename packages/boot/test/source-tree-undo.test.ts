import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { describe, expect, it, type TestContext } from "vitest";

const execute = promisify(execFile);
const script = join(import.meta.dirname, "fixtures/source-tree-undo-store.ts");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const publication = Schema.decodeUnknownSync(Schema.Struct({ batch: Schema.String }));
const versionRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.Int })));
type Entry = {
	readonly path: string;
	readonly content: string | null;
	readonly directory?: true;
	readonly mode?: number;
	readonly repeat?: number;
};
async function fixture(test: TestContext, entries: readonly Entry[]) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-tree-undo-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	for (const entry of entries) {
		if (entry.directory) await mkdir(join(root, entry.path), { recursive: true });
		else {
			await writeFile(join(root, entry.path), (entry.content ?? "").repeat(entry.repeat ?? 1));
			await chmod(join(root, entry.path), entry.mode ?? 0o640);
		}
	}
	const call = async (input: object) =>
		decode((await execute("bun", [script, root, encode(input)], { timeout: 15000 })).stdout.trim());
	const sql = async (statement: string) =>
		decode(
			(
				await execute("bun", [join(import.meta.dirname, "fixtures/store.ts"), join(root, "boot.db"), statement])
			).stdout.trim(),
		);
	await call({ op: "init" });
	return { root, call, sql };
}
async function assertTree(root: string, expected: readonly Entry[]) {
	const found: string[] = [];
	async function visit(path: string) {
		found.push(path);
		if ((await stat(join(root, path))).isDirectory())
			for (const child of await readdir(join(root, path))) await visit(`${path}/${child}`);
	}
	await visit("app");
	expect(found.sort()).toEqual(expected.map((entry) => entry.path).sort());
	for (const entry of expected) {
		const info = await stat(join(root, entry.path));
		if (entry.directory) expect(info.isDirectory()).toBe(true);
		else {
			expect(await readFile(join(root, entry.path), "utf8")).toBe((entry.content ?? "").repeat(entry.repeat ?? 1));
			expect(info.mode & 0o777).toBe(entry.mode ?? 0o640);
		}
	}
}
describe("structural source history undo", () => {
	it.for([
		{ direction: "file to directory", selector: "path" },
		{ direction: "file to directory", selector: "batch" },
		{ direction: "directory to file", selector: "path" },
		{ direction: "directory to file", selector: "batch" },
	] as const)(
		"reverses $direction by $selector and reapplies its explicit version",
		{ timeout: 15000 },
		async ({ direction, selector }, test) => {
			const file: readonly Entry[] = [
				{ path: "app", content: null, directory: true },
				{ path: "app/swap", content: "executable", mode: 0o751 },
				{ path: "app/unrelated", content: "original unrelated" },
			];
			const directory: readonly Entry[] = [
				{ path: "app", content: null, directory: true },
				{ path: "app/swap", content: null, directory: true },
				{ path: "app/swap/empty", content: null, directory: true },
				{ path: "app/swap/child", content: "nested", mode: 0o600 },
				{ path: "app/unrelated", content: "original unrelated" },
			];
			const [before, after] = direction === "file to directory" ? [file, directory] : [directory, file];
			const env = await fixture(test, before);
			const result = publication(await env.call({ op: "publish", desired: after }));
			const originalVersion = versionRows(await env.sql("SELECT id FROM versions WHERE path='app/swap' ORDER BY id"))[0]
				?.id;
			expect(originalVersion).toBeTypeOf("number");
			await writeFile(join(env.root, "app/unrelated"), "later unrelated");
			await writeFile(join(env.root, "app/swap-neighbor"), "created after checkpoint");
			await chmod(join(env.root, "app/swap-neighbor"), 0o600);
			const selection = selector === "path" ? { path: "app/swap" } : { batch: result.batch };
			expect(await env.call({ op: "tree_undo", selection })).toMatchObject({ batch: expect.any(String) });
			const unaffected = "later unrelated";
			await assertTree(env.root, [
				...before.map((entry) => (entry.path === "app/unrelated" ? { ...entry, content: unaffected } : entry)),
				{ path: "app/swap-neighbor", content: "created after checkpoint", mode: 0o600 },
			]);
			expect(await env.call({ op: "tree_undo", selection: { version: originalVersion } })).toMatchObject({
				batch: expect.any(String),
			});
			await assertTree(env.root, [
				...after.map((entry) => (entry.path === "app/unrelated" ? { ...entry, content: unaffected } : entry)),
				{ path: "app/swap-neighbor", content: "created after checkpoint", mode: 0o600 },
			]);
			expect(await env.sql("SELECT COUNT(*) AS n FROM source_batches WHERE state='published'")).toEqual([{ n: 3 }]);
			expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
		},
	);
	it("undoes only a newly created empty directory while preserving later sibling edits", async (test) => {
		const before: readonly Entry[] = [
			{ path: "app", content: null, directory: true },
			{ path: "app/parent", content: null, directory: true },
			{ path: "app/parent/stable", content: "before checkpoint" },
			{ path: "app/large", content: "x", repeat: 1024 * 1024 + 1 },
		];
		const env = await fixture(test, before);
		const published = publication(
			await env.call({
				op: "publish",
				desired: [...before, { path: "app/parent/new", content: null, directory: true }],
			}),
		);
		await writeFile(join(env.root, "app/parent/stable"), "later edit");
		await writeFile(join(env.root, "app/parent/later"), "later file");
		await chmod(join(env.root, "app/parent/later"), 0o600);
		expect(await env.call({ op: "plan", selection: { batch: published.batch } })).toEqual({
			roots: ["app/parent/new"],
			entries: [],
		});
		expect(await env.call({ op: "tree_undo", selection: { batch: published.batch } })).toMatchObject({
			batch: expect.any(String),
		});
		await assertTree(env.root, [
			...before.map((entry) => (entry.path === "app/parent/stable" ? { ...entry, content: "later edit" } : entry)),
			{ path: "app/parent/later", content: "later file", mode: 0o600 },
		]);
		expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
	});
	it("retains one selected tree across newer history and rejects shared-key selector conflicts", async (test) => {
		const env = await fixture(test, [
			{ path: "app", content: null, directory: true },
			{ path: "app/swap", content: "original" },
		]);
		const first = publication(
			await env.call({
				op: "publish",
				desired: [
					{ path: "app", content: null, directory: true },
					{ path: "app/swap", content: null, directory: true },
					{ path: "app/swap/empty", content: null, directory: true },
				],
			}),
		);
		const retry = { family: "family", key: "one logical undo" };
		const selection = { path: "app/swap", retry };
		const plan = await env.call({ op: "plan", selection });
		expect(plan).toMatchObject({
			roots: ["app/swap"],
			entries: [{ path: "app/swap", image: { content: "original", mode: 0o640 } }],
		});
		await env.call({ op: "tree_undo", selection });
		await env.call({
			op: "publish",
			desired: [
				{ path: "app", content: null, directory: true },
				{ path: "app/swap", content: null, directory: true },
				{ path: "app/swap/other", content: "new history" },
			],
		});
		expect(await env.call({ op: "plan", selection })).toEqual(plan);
		for (const conflicting of [
			{ batch: first.batch, retry },
			{ path: "app", retry },
			{ generation: 1, retry },
		])
			expect(await env.call({ op: "plan", selection: conflicting })).toEqual({
				error: "idempotency_conflict",
				path: "revert",
			});
		expect(await env.sql("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'source-revert:%'")).toEqual([{ n: 1 }]);
	});
	it.for(["before", "after"] as const)(
		"refuses omitted %s file bytes without altering source or history",
		async (side, test) => {
			const file: readonly Entry[] = [
				{ path: "app", content: null, directory: true },
				{ path: "app/swap", content: "x", repeat: 1024 * 1024 + 1, mode: 0o600 },
			];
			const directory: readonly Entry[] = [
				{ path: "app", content: null, directory: true },
				{ path: "app/swap", content: null, directory: true },
				{ path: "app/swap/empty", content: null, directory: true },
			];
			const [before, after] = side === "before" ? [file, directory] : [directory, file];
			const env = await fixture(test, before);
			const published = publication(await env.call({ op: "publish", desired: after }));
			const id = versionRows(await env.sql("SELECT id FROM versions WHERE path='app/swap'"))[0]?.id;
			const retry = { family: "family", key: "missing bytes" };
			const selection = side === "before" ? { batch: published.batch, retry } : { version: id, retry };
			const history = await env.sql("SELECT id, path, sha, previous_sha FROM versions ORDER BY id");
			expect(await env.call({ op: "tree_undo", selection })).toEqual({
				error: "version_unavailable",
				path: "app/swap",
			});
			await assertTree(env.root, after);
			expect(await env.sql("SELECT id, path, sha, previous_sha FROM versions ORDER BY id")).toEqual(history);
			expect(await env.sql("SELECT COUNT(*) AS n FROM source_batches")).toEqual([{ n: 1 }]);
			expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
			expect(await env.sql("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'source-revert:%'")).toEqual([{ n: 0 }]);
		},
	);
	it("represents a previously absent app root without inventing an empty directory", async (test) => {
		const env = await fixture(test, []);
		const desired: readonly Entry[] = [
			{ path: "app", content: null, directory: true },
			{ path: "app/empty", content: null, directory: true },
		];
		const published = publication(await env.call({ op: "publish", desired }));
		await assertTree(env.root, desired);
		expect(await env.call({ op: "plan", selection: { batch: published.batch } })).toEqual({
			roots: ["app"],
			entries: [],
		});
		expect(await env.call({ op: "tree_undo", selection: { batch: published.batch } })).toMatchObject({
			batch: expect.any(String),
		});
		await expect(stat(join(env.root, "app"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await env.sql("SELECT COUNT(*) AS n FROM source_batches WHERE state='published'")).toEqual([{ n: 2 }]);
		expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
	});
	it("selects a root-only latest checkpoint instead of undoing an older deletion", async (test) => {
		const env = await fixture(test, [
			{ path: "app", content: null, directory: true },
			{ path: "app/old", content: "previous source" },
		]);
		const desired: readonly Entry[] = [{ path: "app", content: null, directory: true }];
		publication(await env.call({ op: "publish", desired }));
		publication(await env.call({ op: "publish", desired }));
		expect(await env.call({ op: "plan", selection: {} })).toEqual({ roots: [], entries: [] });
		await assertTree(env.root, desired);
		expect(await env.sql("SELECT COUNT(*) AS n FROM source_batches WHERE state='published'")).toEqual([{ n: 2 }]);
		expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
	});
	it("keeps legacy watcher history restorable while excluding its baseline from implicit undo", async (test) => {
		const before: readonly Entry[] = [
			{ path: "app", content: null, directory: true },
			{ path: "app/file", content: "original" },
		];
		const env = await fixture(test, before);
		const baseline = publication(await env.call({ op: "publish", desired: before }));
		await env.sql(`INSERT INTO settings(key,value) VALUES('source.watcher_baseline','${baseline.batch}')`);
		expect(await env.call({ op: "plan", selection: {} })).toEqual({ error: "batch_missing", path: "latest" });
		const edit = publication(
			await env.call({
				op: "publish",
				desired: [
					{ path: "app", content: null, directory: true },
					{ path: "app/file", content: null, directory: true },
					{ path: "app/file/child", content: "legacy watcher edit" },
				],
			}),
		);
		await env.sql(`UPDATE versions SET agent='watcher' WHERE batch='${edit.batch}'`);
		const history = await env.sql("SELECT * FROM versions ORDER BY id");
		expect(await env.call({ op: "plan", selection: {} })).toEqual(
			await env.call({ op: "plan", selection: { batch: edit.batch } }),
		);
		expect(await env.sql("SELECT * FROM versions ORDER BY id")).toEqual(history);
		expect(await env.call({ op: "tree_undo", selection: { batch: edit.batch } })).toMatchObject({
			batch: expect.any(String),
		});
		await assertTree(env.root, before);
		expect(await env.sql("SELECT value FROM settings WHERE key='source.watcher_baseline'")).toEqual([
			{ value: baseline.batch },
		]);
	});

	it("leaves ordinary file-only history on its existing undo path", async (test) => {
		const env = await fixture(test, [
			{ path: "app", content: null, directory: true },
			{ path: "app/file", content: "before" },
		]);
		const published = publication(
			await env.call({ op: "file_publish", desired: [{ path: "app/file", content: "after" }] }),
		);
		for (const selection of [{ path: "app/file" }, { batch: published.batch }])
			expect(await env.call({ op: "plan", selection })).toBeNull();
		expect(await readFile(join(env.root, "app/file"), "utf8")).toBe("after");
	});
});
