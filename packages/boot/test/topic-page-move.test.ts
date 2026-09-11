import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { describe, expect, it, type TestContext } from "vitest";

const execute = promisify(execFile);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const script = join(import.meta.dirname, "fixtures/topic-page-move-store.ts");
async function fixture(test: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-page-move-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "pages/old/empty"), { recursive: true });
	await writeFile(join(root, "pages/old/page.md"), "original page");
	await chmod(join(root, "pages/old/page.md"), 0o600);
	const call = async (input: object) => decode((await execute("bun", [script, root, encode(input)])).stdout.trim());
	const sql = async (statement: string) =>
		decode(
			(
				await execute("bun", [join(import.meta.dirname, "fixtures/store.ts"), join(root, "boot.db"), statement])
			).stdout.trim(),
		);
	const crash = async (at: number) => {
		const child = spawn("bun", [script, root, encode({ op: "publish", crash: at })]);
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
				if (output.includes("BOUNDARY")) resolve();
			});
		});
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
	};
	return { root, call, sql, crash };
}

describe("recoverable topic page directory move", () => {
	it("prepares without changing visible paths and holds publisher admission across restart until abort", async (test) => {
		const env = await fixture(test);
		expect(await env.call({ op: "prepare" })).toEqual({ page_source: true });
		expect(await readFile(join(env.root, "pages/old/page.md"), "utf8")).toBe("original page");
		await expect(stat(join(env.root, "pages/new"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await env.call({ op: "read" })).toEqual([{ name: "old", type: "directory" }]);
		expect(await env.call({ op: "recover" })).toMatchObject({ error: "publication_pending" });
		expect(await env.call({ op: "prepare", id: "another" })).toMatchObject({ error: "publication_pending" });
		await env.call({ op: "abort" });
		expect(await env.call({ op: "read" })).toEqual([{ name: "old", type: "directory" }]);
		expect(await env.call({ op: "prepared_source" })).toMatchObject({ error: "publication_pending" });
	});
	it.for([0, 1])(
		"recovers process death at directory rename boundary %i, preserving empty dirs and mode",
		async (at, test) => {
			const env = await fixture(test);
			await env.call({ op: "prepare" });
			await env.crash(at);
			expect(await env.sql("SELECT state FROM topic_page_moves")).toEqual([{ state: "publishing" }]);
			expect(await env.call({ op: "abort" })).toMatchObject({ error: "external_conflict" });
			await env.call({ op: "publish" });
			await env.call({ op: "publish" });
			await expect(stat(join(env.root, "pages/old"))).rejects.toMatchObject({ code: "ENOENT" });
			expect((await stat(join(env.root, "pages/new/target/empty"))).isDirectory()).toBe(true);
			expect(await readFile(join(env.root, "pages/new/target/page.md"), "utf8")).toBe("original page");
			expect((await stat(join(env.root, "pages/new/target/page.md"))).mode & 0o777).toBe(0o600);
			expect(await env.call({ op: "read" })).toEqual([{ name: "new", type: "directory" }]);
			await env.call({ op: "finish" });
			await env.call({ op: "finish" });
			await writeFile(join(env.root, "pages/new/target/page.md"), "later edit");
			await env.call({ op: "publish" });
			expect(await readFile(join(env.root, "pages/new/target/page.md"), "utf8")).toBe("later edit");
		},
	);
	it("replays completed cleanup while a later move is pending across restarts", async (test) => {
		const env = await fixture(test);
		await env.call({ op: "prepare" });
		await env.call({ op: "publish" });
		await env.call({ op: "finish" });
		await env.call({ op: "prepare", id: "second", from: "new/target", to: "final" });
		await env.call({ op: "publish", id: "second" });
		expect(await env.call({ op: "finish" })).toBe(null);
		expect(await env.call({ op: "read" })).toEqual([
			{ name: "final", type: "directory" },
			{ name: "new", type: "directory" },
		]);
		expect(await env.call({ op: "finish", id: "second" })).toBe(null);
		expect(await env.sql("SELECT state FROM topic_page_moves ORDER BY id")).toEqual([
			{ state: "completed" },
			{ state: "completed" },
		]);
		expect(await readFile(join(env.root, "pages/final/page.md"), "utf8")).toBe("original page");
	});
	it("aborts an absent move without blocking or discarding an ordinary prepared page publication", async (test) => {
		const env = await fixture(test);
		expect(await env.call({ op: "abort_with_source" })).toBe(null);
		expect(await readFile(join(env.root, "pages/other.md"), "utf8")).toBe("other");
		expect(await env.sql("SELECT * FROM topic_page_moves")).toEqual([]);
	});
	it("keeps an already-renamed tree recoverable if publishing its SQL receipt fails", async (test) => {
		const env = await fixture(test);
		await env.call({ op: "prepare" });
		await env.sql(
			"CREATE TRIGGER fail_move_receipt BEFORE UPDATE ON topic_page_moves WHEN NEW.state='published' BEGIN SELECT RAISE(ABORT,'disk full'); END",
		);
		expect(await env.call({ op: "publish" })).toEqual({ error: "sql_error" });
		expect(await readFile(join(env.root, "pages/new/target/page.md"), "utf8")).toBe("original page");
		await env.sql("DROP TRIGGER fail_move_receipt");
		await env.call({ op: "publish" });
		expect(await env.sql("SELECT state FROM topic_page_moves")).toEqual([{ state: "published" }]);
	});
	it.for(["content", "mode", "identity", "destination"])(
		"preserves an external %s conflict and its pending intent",
		async (kind, test) => {
			const env = await fixture(test);
			await env.call({ op: "prepare" });
			if (kind === "content") await writeFile(join(env.root, "pages/old/page.md"), "external");
			if (kind === "mode") await chmod(join(env.root, "pages/old/page.md"), 0o644);
			if (kind === "identity") {
				await rename(join(env.root, "pages/old"), join(env.root, "pages/saved"));
				await mkdir(join(env.root, "pages/old/empty"), { recursive: true });
				await writeFile(join(env.root, "pages/old/page.md"), "original page");
				await chmod(join(env.root, "pages/old/page.md"), 0o600);
			}
			if (kind === "destination") await mkdir(join(env.root, "pages/new/target"), { recursive: true });
			expect(await env.call({ op: "publish" })).toMatchObject({ error: "external_conflict" });
			expect(await env.sql("SELECT state FROM topic_page_moves")).toEqual([{ state: "prepared" }]);
			expect((await stat(join(env.root, "pages/old"))).isDirectory()).toBe(true);
		},
	);
	it.for(["old", "old/child", "../escape", ".comms-move", "existing", "dangling"])(
		"rejects destination %s without creating an intent",
		async (to, test) => {
			const env = await fixture(test);
			await mkdir(join(env.root, "pages/existing"));
			await symlink(join(env.root, "missing"), join(env.root, "pages/dangling"));
			expect(await env.call({ op: "prepare", to })).toMatchObject({ error: expect.any(String) });
			expect(await env.sql("SELECT * FROM topic_page_moves")).toEqual([]);
		},
	);
	it("rejects ancestor destinations without creating an intent", async (test) => {
		const env = await fixture(test);
		await mkdir(join(env.root, "pages/old/child"));
		expect(await env.call({ op: "prepare", from: "old/child", to: "old" })).toMatchObject({ error: "path_conflict" });
		expect(await env.sql("SELECT * FROM topic_page_moves")).toEqual([]);
	});
	it.for(["link", ".comms-private"])("rejects unsafe source entry %s", async (name, test) => {
		const env = await fixture(test);
		if (name === "link") await symlink(join(env.root, "missing"), join(env.root, "pages/old/link"));
		else await writeFile(join(env.root, "pages/old/.comms-private"), "private");
		expect(await env.call({ op: "prepare" })).toMatchObject({ error: "invalid_path" });
		expect(await env.sql("SELECT * FROM topic_page_moves")).toEqual([]);
	});
	it("rejects oversized descendant paths and filesystem aliases", async (test) => {
		const env = await fixture(test);
		await mkdir(join(env.root, "pages/old/deep"));
		expect(await env.call({ op: "prepare", to: "x".repeat(198) })).toMatchObject({ error: "invalid_path" });
		const aliases = await stat(join(env.root, "pages/OLD")).then(
			() => true,
			() => false,
		);
		if (aliases) expect(await env.call({ op: "prepare", to: "OLD/moved" })).toMatchObject({ error: "invalid_path" });
		expect(await env.sql("SELECT * FROM topic_page_moves")).toEqual([]);
	});

	it("handles SQL-only topics without creating phantom page directories and binds preparation retries", async (test) => {
		const env = await fixture(test);
		expect(await env.call({ op: "prepare", from: "absent" })).toEqual({ page_source: false });
		expect(await env.call({ op: "prepare", from: "absent" })).toEqual({ page_source: false });
		expect(await env.call({ op: "prepare", from: "different" })).toMatchObject({ error: "idempotency_conflict" });
		await env.call({ op: "publish" });
		await env.call({ op: "finish" });
		await expect(stat(join(env.root, "pages/new"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
