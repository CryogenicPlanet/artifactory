import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { describe, expect, it, type TestContext } from "vitest";

const execute = promisify(execFile);
const script = join(import.meta.dirname, "fixtures/source-tree-store.ts");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const publication = Schema.decodeUnknownSync(
	Schema.Struct({ batch: Schema.String, mutations: Schema.Array(Schema.String) }),
);
type Entry = {
	readonly path: string;
	readonly content: string | null;
	readonly directory?: true;
	readonly mode?: number;
};
async function fixture(test: TestContext, entries: readonly Entry[]) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-source-tree-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	for (const entry of entries) {
		if (entry.directory) await mkdir(join(root, entry.path), { recursive: true });
		else {
			await writeFile(join(root, entry.path), entry.content ?? "");
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
	const crash = async (at: number, desired: readonly Entry[]) => {
		const child = spawn("bun", [script, root, encode({ op: "publish", desired, crash: at })]);
		test.onTestFinished(() => {
			child.kill("SIGKILL");
		});
		let output = "";
		let errors = "";
		child.stderr.on("data", (chunk: Buffer) => {
			errors += chunk.toString();
		});
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Missing crash boundary ${at}: ${output} ${errors}`)), 15000);
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.on("exit", () => {
				clearTimeout(timer);
				reject(new Error(`Early exit: ${output} ${errors}`));
			});
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes("JOURNALED")) {
					clearTimeout(timer);
					resolve();
				}
			});
		});
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
	};
	await call({ op: "init" });
	return { root, call, sql, crash };
}
async function assertTree(root: string, desired: readonly Entry[]) {
	const paths: string[] = [];
	async function visit(path: string) {
		paths.push(path);
		const info = await stat(join(root, path));
		if (info.isDirectory())
			for (const name of await readdir(join(root, path))) {
				await visit(`${path}/${name}`);
			}
	}
	await visit("app");
	expect(paths.sort()).toEqual(desired.map((entry) => entry.path).sort());
	for (const entry of desired) {
		const info = await stat(join(root, entry.path));
		if (entry.directory) expect(info.isDirectory()).toBe(true);
		else {
			expect(await readFile(join(root, entry.path), "utf8")).toBe(entry.content);
			expect(info.mode & 0o777).toBe(entry.mode ?? 0o640);
		}
	}
}
describe("typed source tree publication", () => {
	it("upgrades a version-12 pending file journal without changing its absent/file identity", async (test) => {
		const env = await fixture(test, [
			{ path: "app", content: null, directory: true },
			{ path: "app/legacy", content: "before" },
		]);
		for (const statement of [
			"ALTER TABLE source_changes DROP COLUMN before_directory",
			"ALTER TABLE source_changes DROP COLUMN desired_directory",
			"ALTER TABLE versions DROP COLUMN previous_directory",
			"ALTER TABLE versions DROP COLUMN directory",
			"DROP TABLE public_paths",
			"DROP INDEX events_type_seq",
			"DROP INDEX events_actor_seq",
			"DROP INDEX events_instance_seq",
			"DROP INDEX events_level_seq",
			"DROP INDEX events_topic_seq",
			"ALTER TABLE events DROP COLUMN type",
			"ALTER TABLE events DROP COLUMN actor",
			"ALTER TABLE events DROP COLUMN instance",
			"ALTER TABLE events DROP COLUMN level",
			"ALTER TABLE events DROP COLUMN topic",
			"DROP TABLE topic_moves",
			"DROP TABLE topic_page_moves",
			"DROP TABLE db_restore_requests",
			"PRAGMA user_version=12",
			"INSERT INTO source_batches VALUES ('legacy',NULL,'codex',1,'publishing')",
			"INSERT INTO source_changes(batch,path,before,before_sha,before_mode,desired,desired_sha,desired_mode) VALUES ('legacy','app/new',NULL,NULL,NULL,X'6E6577','11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437',416)",
		])
			await env.sql(statement);
		expect(await env.call({ op: "recover" })).toMatchObject({ batch: "legacy" });
		expect(await readFile(join(env.root, "app/new"), "utf8")).toBe("new");
		expect(await readFile(join(env.root, "app/legacy"), "utf8")).toBe("before");
		expect(await env.sql("SELECT previous_directory,directory FROM versions")).toEqual([
			{ previous_directory: 0, directory: 0 },
		]);
		expect(await env.sql("PRAGMA user_version")).toEqual([{ user_version: 14 }]);
	});

	it.for(["file to directory", "directory to file"] as const)(
		"recovers SIGKILL at every %s mutation boundary",
		{ timeout: 120000 },
		async (kind, test) => {
			const file: readonly Entry[] = [
				{ path: "app", content: null, directory: true },
				{ path: "app/swap", content: "executable", mode: 0o751 },
				{ path: "app/stable", content: "unchanged" },
			];
			const directory: readonly Entry[] = [
				{ path: "app", content: null, directory: true },
				{ path: "app/swap", content: null, directory: true },
				{ path: "app/swap/empty", content: null, directory: true },
				{ path: "app/swap/child", content: "nested", mode: 0o600 },
				{ path: "app/stable", content: "unchanged" },
			];
			const [before, desired] = kind === "file to directory" ? [file, directory] : [directory, file];
			const trace = await fixture(test, before);
			const completed = publication(await trace.call({ op: "publish", desired }));
			expect(completed.mutations.length).toBeGreaterThanOrEqual(4);
			await assertTree(trace.root, desired);
			for (let boundary = 0; boundary <= completed.mutations.length; boundary++) {
				const env = await fixture(test, before);
				await env.crash(boundary, desired);
				expect(await env.sql("SELECT state FROM source_batches")).toEqual([{ state: "publishing" }]);
				expect(await env.sql("SELECT COUNT(*) AS n FROM versions")).toEqual([{ n: 0 }]);
				expect(await env.call({ op: "recover" })).toMatchObject({ batch: "tree-batch" });
				await assertTree(env.root, desired);
				const history = await env.sql("SELECT path, sha, previous_sha FROM versions ORDER BY path");
				expect(await env.call({ op: "recover" })).toEqual({ batch: null, mutations: [] });
				expect(await env.sql("SELECT path, sha, previous_sha FROM versions ORDER BY path")).toEqual(history);
				expect(await env.sql("SELECT COUNT(*) AS n FROM versions WHERE path='app/swap'")).toEqual([{ n: 1 }]);
				expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
			}
		},
	);
	it.for(["file", "symlink"] as const)("preserves an unexpected %s child after interruption", async (kind, test) => {
		const env = await fixture(test, [
			{ path: "app", content: null, directory: true },
			{ path: "app/swap", content: null, directory: true },
			{ path: "app/swap/known", content: "known" },
		]);
		await env.crash(1, [
			{ path: "app", content: null, directory: true },
			{ path: "app/swap", content: "replacement" },
		]);
		await writeFile(join(env.root, "outside"), "preserve outside");
		if (kind === "file") await writeFile(join(env.root, "app/swap/unexpected"), "external");
		else await symlink(join(env.root, "outside"), join(env.root, "app/swap/unexpected"));
		expect(await env.call({ op: "recover" })).toMatchObject({ error: "external_conflict" });
		expect(await readFile(join(env.root, "app/swap/unexpected"), "utf8")).toBe(
			kind === "file" ? "external" : "preserve outside",
		);
		expect(await readFile(join(env.root, "outside"), "utf8")).toBe("preserve outside");
		expect(await env.sql("SELECT state FROM source_batches")).toEqual([{ state: "publishing" }]);
		expect(await env.sql("SELECT * FROM versions")).toEqual([]);
	});
	it("checks unchanged source before making any structural mutation", async (test) => {
		const env = await fixture(test, [
			{ path: "app", content: null, directory: true },
			{ path: "app/swap", content: "original" },
			{ path: "app/stable", content: "unchanged" },
		]);
		await env.crash(0, [
			{ path: "app", content: null, directory: true },
			{ path: "app/swap", content: null, directory: true },
			{ path: "app/stable", content: "unchanged" },
		]);
		await writeFile(join(env.root, "app/stable"), "external");
		expect(await env.call({ op: "recover" })).toEqual({ error: "external_conflict", path: "app/stable" });
		expect(await readFile(join(env.root, "app/swap"), "utf8")).toBe("original");
		expect(await readFile(join(env.root, "app/stable"), "utf8")).toBe("external");
		expect(await env.sql("SELECT * FROM versions")).toEqual([]);
	});
	it("leaves the journal when history commit fails and publishes exactly once after restart", async (test) => {
		const env = await fixture(test, [
			{ path: "app", content: null, directory: true },
			{ path: "app/swap", content: "original" },
		]);
		const desired: readonly Entry[] = [
			{ path: "app", content: null, directory: true },
			{ path: "app/swap", content: null, directory: true },
			{ path: "app/swap/empty", content: null, directory: true },
		];
		await env.sql(
			"CREATE TRIGGER fail_history BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT,'fixture disk full'); END",
		);
		expect(await env.call({ op: "publish", desired })).toEqual({ error: "sql_error" });
		await assertTree(env.root, desired);
		expect(await env.sql("SELECT state FROM source_batches")).toEqual([{ state: "publishing" }]);
		expect(await env.sql("SELECT * FROM versions")).toEqual([]);
		await env.sql("DROP TRIGGER fail_history");
		expect(await env.call({ op: "recover" })).toMatchObject({ batch: "tree-batch" });
		expect(await env.sql("SELECT COUNT(*) AS n FROM versions WHERE path='app/swap'")).toEqual([{ n: 1 }]);
		expect(await env.call({ op: "recover" })).toEqual({ batch: null, mutations: [] });
	});
});
