import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Console, Effect, Schema } from "effect";
import { describe, expect, it, type TestContext } from "vitest";

const execute = promisify(execFile);
const script = join(import.meta.dirname, "fixtures/source-store.ts");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const receipt = Schema.decodeUnknownSync(Schema.Struct({ batch: Schema.String }));
async function fixture(test: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-source-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "app"));
	await writeFile(join(root, "app/main.ts"), "one");
	await chmod(join(root, "app/main.ts"), 0o644);
	const started = performance.now();
	const operations: { operation: string; at_ms: number; event: string }[] = [];
	const record = (operation: string, event: string) => {
		operations.push({ operation, at_ms: Math.round(performance.now() - started), event });
	};
	test.onTestFailed(() => Effect.runSync(Console.error("Source fixture diagnostic", operations)));
	const call = async (input: object) => {
		const operation = "op" in input && typeof input.op === "string" ? input.op : "unknown";
		record(operation, "start");
		try {
			const result = await execute("bun", [script, root, encode(input)], { maxBuffer: 8 * 1024 * 1024 });
			record(operation, "exit");
			return decode(result.stdout.trim());
		} catch (error) {
			record(operation, "failed");
			throw error;
		}
	};
	const sql = async (statement: string) => {
		record("sql", "start");
		try {
			const result = await execute("bun", [
				join(import.meta.dirname, "fixtures/store.ts"),
				join(root, "boot.db"),
				statement,
			]);
			record("sql", "exit");
			return decode(result.stdout.trim());
		} catch (error) {
			record("sql", "failed");
			throw error;
		}
	};
	const crash = async (at: number, writes: readonly object[], batch?: string) => {
		record(`crash-${at}`, "start");
		const child = spawn("bun", [
			script,
			root,
			encode({ op: batch === undefined ? "publish" : "page_undo", crash: at, writes, batch }),
		]);
		child.once("exit", () => record(`crash-${at}`, "exit"));
		test.onTestFinished(() => {
			child.kill("SIGKILL");
		});
		let output = "";
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		await new Promise<void>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", () => reject(new Error(`Early exit ${output} ${stderr}`)));
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes("JOURNALED")) resolve();
			});
		});
		record(`crash-${at}`, "journaled");
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
	};
	await call({ op: "init" });
	return { root, call, sql, crash };
}
describe("recoverable source publication", () => {
	it("records first-edit images, restores deleted executable modes and preserves running snapshot copies", async (test) => {
		const env = await fixture(test);
		await writeFile(join(env.root, "app/run.sh"), "old executable");
		await chmod(join(env.root, "app/run.sh"), 0o751);
		await mkdir(join(env.root, "snapshot"));
		await copyFile(join(env.root, "app/main.ts"), join(env.root, "snapshot/main.ts"));
		const result = receipt(
			await env.call({
				op: "publish",
				writes: [
					{ path: "app/main.ts", content: "new" },
					{ path: "app/run.sh", content: null },
					{ path: "app/nested/new.ts", content: "create" },
				],
			}),
		);
		expect(await readFile(join(env.root, "app/main.ts"), "utf8")).toBe("new");
		expect(await readFile(join(env.root, "snapshot/main.ts"), "utf8")).toBe("one");
		expect(
			await env.sql(
				"SELECT path, CAST(previous_content AS TEXT) AS previous, previous_mode, CAST(content AS TEXT) AS content FROM versions ORDER BY path",
			),
		).toEqual([
			{ path: "app/main.ts", previous: "one", previous_mode: 0o644, content: "new" },
			{ path: "app/nested/new.ts", previous: null, previous_mode: null, content: "create" },
			{ path: "app/run.sh", previous: "old executable", previous_mode: 0o751, content: null },
		]);
		await env.call({ op: "undo", batch: result.batch });
		expect(await readFile(join(env.root, "app/main.ts"), "utf8")).toBe("one");
		expect(await readFile(join(env.root, "app/run.sh"), "utf8")).toBe("old executable");
		expect((await stat(join(env.root, "app/run.sh"))).mode & 0o777).toBe(0o751);
		await expect(stat(join(env.root, "app/nested/new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
	});
	it.for([0, 1, 2])(
		"recovers process death at replacement boundary %i idempotently from its own journal",
		// Nine sequential Bun launches reached recovery only after 5s in Linux CI.
		{ timeout: 15000 },
		async (at, test) => {
			const env = await fixture(test);
			await env.crash(at, [
				{ path: "app/main.ts", content: "new" },
				{ path: "app/nested/deep/new.ts", content: "created" },
			]);
			expect(await env.sql("SELECT state FROM source_batches")).toEqual([{ state: "publishing" }]);
			expect(await env.call({ op: "read" })).toMatchObject({ error: "publication_pending" });
			expect(await env.call({ op: "browse", path: "app" })).toMatchObject({ error: "publication_pending" });
			// Journal recovery must not depend on the holder's overlay surviving.
			await env.sql("DELETE FROM staging");
			const recovered = await env.call({ op: "recover" });
			expect(recovered).toMatchObject({
				batch: expect.any(String),
				syncs: expect.arrayContaining([join(env.root, "app/nested"), join(env.root, "app/nested/deep")]),
			});
			expect(await readFile(join(env.root, "app/main.ts"), "utf8")).toBe("new");
			expect(await readFile(join(env.root, "app/nested/deep/new.ts"), "utf8")).toBe("created");
			expect(await env.call({ op: "recover" })).toEqual({ batch: null, syncs: [] });
			expect(await env.sql("SELECT COUNT(*) AS n FROM versions")).toEqual([{ n: 2 }]);
		},
	);
	it.for(["bytes", "mode"])("preserves an external %s conflict and keeps publication pending", async (kind, test) => {
		const env = await fixture(test);
		await env.crash(0, [{ path: "app/main.ts", content: "new" }]);
		if (kind === "bytes") await writeFile(join(env.root, "app/main.ts"), "external");
		else await chmod(join(env.root, "app/main.ts"), 0o700);
		expect(await env.call({ op: "recover" })).toEqual({ error: "external_conflict", path: "app/main.ts" });
		expect(await readFile(join(env.root, "app/main.ts"), "utf8")).toBe(kind === "bytes" ? "external" : "one");
		expect(await env.sql("SELECT COUNT(*) AS n FROM source_changes")).toEqual([{ n: 1 }]);
		expect(await env.sql("SELECT * FROM versions")).toEqual([]);
	});
	it("keeps anchored edits atomic, detects stale/overlapping anchors, and serializes concurrent holder edits", async (test) => {
		const env = await fixture(test);
		const result = await env.call({ op: "anchors" });
		expect(result).toMatchObject({
			rejected: { _tag: "Failure", failure: { code: "anchor_not_found" } },
			untouched: "one",
			stale: { _tag: "Failure", failure: { code: "stale_base" } },
			ambiguous: { _tag: "Failure", failure: { code: "ambiguous_anchor" } },
			disk: "one",
		});
		const concurrent = Schema.decodeUnknownSync(
			Schema.Struct({ concurrent: Schema.Array(Schema.Struct({ _tag: Schema.String })) }),
		)(result).concurrent;
		expect(concurrent.filter((item) => item._tag === "Success")).toHaveLength(1);
	});
	it("rejects symlinks, dangling links, traversal, excluded paths, non-files and batch collisions; failed prepare releases pin", async (test) => {
		const env = await fixture(test);
		await symlink(join(env.root, "missing-target"), join(env.root, "app/dangling"));
		await mkdir(join(env.root, "outside"));
		await symlink(join(env.root, "outside"), join(env.root, "app/link"));
		await mkdir(join(env.root, "app/directory"));
		for (const path of [
			"app/../boot.db",
			"app//x",
			"app/node_modules/x",
			"app/.vite/x",
			"app/ui/dist/x",
			"app/dangling",
			"app/dangling/file.ts",
			"app/link/x",
			"app/directory",
		])
			expect(await env.call({ op: "read", path })).toMatchObject({ error: "invalid_path" });
		expect(
			await env.call({
				op: "publish",
				writes: [
					{ path: "pages/a", content: "x" },
					{ path: "pages/a-b", content: "x" },
					{ path: "pages/a/b", content: "x" },
				],
			}),
		).toMatchObject({ error: "path_conflict" });
		expect(await env.call({ op: "prepare_failure" })).toMatchObject({
			failed: { _tag: "Failure", failure: { code: "invalid_path" } },
			lock: { cutover_in_flight: 0 },
		});
		await env.sql("DELETE FROM staging");
		await rm(join(env.root, "app"), { recursive: true });
		await symlink(join(env.root, "outside"), join(env.root, "app"));
		expect(await env.call({ op: "read", path: "app/new.ts" })).toMatchObject({ error: "invalid_path" });
		expect(await env.call({ op: "publish", writes: [] })).toMatchObject({ error: "invalid_path" });
	});
	it("stages undo atomically, preserves unrelated work, and leaves publication journal intact on history failure", async (test) => {
		const env = await fixture(test);
		const result = receipt(
			await env.call({
				op: "publish",
				writes: [
					{ path: "app/main.ts", content: "new" },
					{ path: "app/z.ts", content: "created" },
				],
			}),
		);
		await env.sql(
			"CREATE TRIGGER fail_stage BEFORE INSERT ON staging WHEN NEW.path='app/z.ts' BEGIN SELECT RAISE(ABORT,'disk full fixture'); END",
		);
		expect(await env.call({ op: "undo", batch: result.batch })).toMatchObject({ error: "sql_error" });
		expect(await env.sql("SELECT * FROM staging")).toEqual([]);
		expect(await env.sql("SELECT cutover_in_flight FROM edit_lock")).toEqual([{ cutover_in_flight: 0 }]);
		await env.sql("DROP TRIGGER fail_stage");
		await env.sql(
			"INSERT INTO staging (lock_id,path,content,sha,at) SELECT id,'app/unrelated.ts',NULL,NULL,0 FROM edit_lock",
		);
		expect(await env.call({ op: "undo", batch: result.batch })).toMatchObject({ error: "staging_not_empty" });
		expect(await env.sql("SELECT path FROM staging")).toEqual([{ path: "app/unrelated.ts" }]);
		await env.sql("DELETE FROM staging");
		await env.sql(
			"CREATE TRIGGER fail_history BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT,'disk full fixture'); END",
		);
		expect(await env.call({ op: "undo", batch: result.batch })).toMatchObject({ error: "sql_error" });
		expect(await readFile(join(env.root, "app/main.ts"), "utf8")).toBe("one");
		expect(await env.sql("SELECT COUNT(*) AS n FROM source_changes")).toEqual([{ n: 2 }]);
		expect(await env.sql("SELECT COUNT(*) AS n FROM versions")).toEqual([{ n: 2 }]);
		await env.sql("DROP TRIGGER fail_history");
		await env.call({ op: "recover" });
		expect(await env.sql("SELECT COUNT(*) AS n FROM versions")).toEqual([{ n: 4 }]);
		expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
	});
	it("publishes pages without acquiring or changing an app edit lock", async (test) => {
		const env = await fixture(test);
		await env.sql(
			"INSERT INTO edit_lock (singleton,id,holder_family,agent,since,expires,ttl_seconds,note) VALUES (1,'other','other-family','other',0,9999999999999,900,'busy')",
		);
		const result = receipt(
			await env.call({ op: "publish", writes: [{ path: "pages/topic/index.md", content: "page", mode: 0o600 }] }),
		);
		expect(await readFile(join(env.root, "pages/topic/index.md"), "utf8")).toBe("page");
		expect((await stat(join(env.root, "pages/topic/index.md"))).mode & 0o777).toBe(0o600);
		expect(await env.sql("SELECT id FROM edit_lock")).toEqual([{ id: "other" }]);
		expect(await env.call({ op: "previous", batch: result.batch })).toEqual([
			{ path: "pages/topic/index.md", content: null },
		]);
	});

	it.for([0, 1, 2])(
		"recovers a page batch undo after process death at replacement %i",
		{ timeout: 15000 },
		async (at, test) => {
			const env = await fixture(test);
			await env.call({
				op: "publish",
				writes: [
					{ path: "pages/topic/a.md", content: "before a", mode: 0o600 },
					{ path: "pages/topic/b.md", content: "before b", mode: 0o640 },
				],
			});
			const changed = receipt(
				await env.call({
					op: "publish",
					writes: [
						{ path: "pages/topic/a.md", content: "after a", mode: 0o644 },
						{ path: "pages/topic/b.md", content: "after b", mode: 0o644 },
					],
				}),
			);
			await env.sql(
				"INSERT INTO edit_lock (singleton,id,holder_family,agent,since,expires,ttl_seconds,note) VALUES (1,'other','other-family','other',0,9999999999999,900,'busy')",
			);
			await env.crash(at, [], changed.batch);
			expect(await env.call({ op: "read", path: "pages/topic/a.md" })).toMatchObject({ error: "publication_pending" });
			expect(await env.sql("SELECT COUNT(*) AS n FROM source_changes")).toEqual([{ n: 2 }]);
			await env.call({ op: "recover" });
			for (const [name, mode] of [
				["a", 0o600],
				["b", 0o640],
			] as const) {
				expect(await readFile(join(env.root, `pages/topic/${name}.md`), "utf8")).toBe(`before ${name}`);
				expect((await stat(join(env.root, `pages/topic/${name}.md`))).mode & 0o777).toBe(mode);
			}
			expect(await env.sql("SELECT id FROM edit_lock")).toEqual([{ id: "other" }]);
			expect(await env.sql("SELECT COUNT(*) AS n FROM versions")).toEqual([{ n: 6 }]);
			expect(await env.call({ op: "recover" })).toEqual({ batch: null, syncs: [] });
			expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
		},
	);

	it("retains the page undo journal if history commit fails and finishes it once on restart", async (test) => {
		const env = await fixture(test);
		const changed = receipt(
			await env.call({ op: "publish", writes: [{ path: "pages/topic/new.md", content: "created" }] }),
		);
		await env.sql(
			"CREATE TRIGGER fail_history BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT,'disk full fixture'); END",
		);
		expect(await env.call({ op: "page_undo", batch: changed.batch })).toMatchObject({ error: "sql_error" });
		await expect(stat(join(env.root, "pages/topic/new.md"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await env.sql("SELECT COUNT(*) AS n FROM source_changes")).toEqual([{ n: 1 }]);
		await env.sql("DROP TRIGGER fail_history");
		await env.call({ op: "recover" });
		expect(await env.sql("SELECT COUNT(*) AS n FROM versions")).toEqual([{ n: 2 }]);
		expect(await env.call({ op: "recover" })).toEqual({ batch: null, syncs: [] });
		expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
	});

	it("preserves bytes and history when filesystem names alias, including new names in one batch", async (test) => {
		const env = await fixture(test);
		await env.call({ op: "publish", writes: [{ path: "pages/Report.md", content: "original" }] });
		const aliases = await stat(join(env.root, "pages/report.md")).then(
			() => true,
			() => false,
		);
		const history = await env.sql("SELECT path, sha, previous_sha FROM versions ORDER BY id");
		const second = await env.call({ op: "publish", writes: [{ path: "pages/report.md", content: "replacement" }] });
		if (aliases) {
			expect(second).toMatchObject({ error: "invalid_path" });
			expect(await env.sql("SELECT path, sha, previous_sha FROM versions ORDER BY id")).toEqual(history);
		} else {
			expect(second).toMatchObject({ batch: expect.any(String) });
			expect(await readFile(join(env.root, "pages/report.md"), "utf8")).toBe("replacement");
		}
		expect(await readFile(join(env.root, "pages/Report.md"), "utf8")).toBe("original");
		const beforeBatch = await env.sql("SELECT path, sha, previous_sha FROM versions ORDER BY id");
		const batch = await env.call({
			op: "publish",
			writes: [
				{ path: "pages/new/Notes.md", content: "first" },
				{ path: "pages/new/notes.md", content: "second" },
			],
		});
		if (aliases) {
			expect(batch).toMatchObject({ error: "path_conflict" });
			await expect(stat(join(env.root, "pages/new"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await env.sql("SELECT path, sha, previous_sha FROM versions ORDER BY id")).toEqual(beforeBatch);
		} else {
			expect(batch).toMatchObject({ batch: expect.any(String) });
			expect(await readFile(join(env.root, "pages/new/Notes.md"), "utf8")).toBe("first");
			expect(await readFile(join(env.root, "pages/new/notes.md"), "utf8")).toBe("second");
		}
		expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
		expect(await env.sql("SELECT id FROM source_batches WHERE state='publishing'")).toEqual([]);
	});

	it("accepts oversized images, recovers their bytes, and distinguishes omitted history from deletion", async (test) => {
		const env = await fixture(test);
		await env.crash(0, [{ path: "app/main.ts", content: "x", repeat: 1024 * 1024 + 1 }]);
		await env.call({ op: "recover" });
		expect((await stat(join(env.root, "app/main.ts"))).size).toBe(1024 * 1024 + 1);
		const batches = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })))(
			await env.sql("SELECT id FROM source_batches"),
		);
		expect(await env.call({ op: "previous", batch: batches[0]?.id })).toMatchObject([
			{ path: "app/main.ts", content: expect.any(Object) },
		]);
		expect(
			await env.sql("SELECT content IS NULL AS omitted, sha IS NOT NULL AS exists_image, reason FROM versions"),
		).toEqual([{ omitted: 1, exists_image: 1, reason: "size_limit" }]);
		await env.sql("DELETE FROM edit_lock");
		await env.sql("DELETE FROM staging");
		const removed = receipt(await env.call({ op: "publish", writes: [{ path: "app/main.ts", content: null }] }));
		expect(await env.call({ op: "previous", batch: removed.batch })).toEqual({
			error: "version_unavailable",
			path: "app/main.ts",
		});
		expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
	});
});
