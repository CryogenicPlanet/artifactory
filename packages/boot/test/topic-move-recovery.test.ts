import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, symlink } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
const execute = promisify(execFile);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
async function fixture(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-move-recovery-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "pages/old/empty"), { recursive: true });
	await writeFile(join(root, "pages/old/page.md"), "preserved");
	await chmod(join(root, "pages/old/page.md"), 0o600);
	const runner = join(root, "runner");
	await cp(join(import.meta.dirname, "../src"), join(runner, "src"), { recursive: true });
	await mkdir(join(runner, "test/fixtures"), { recursive: true });
	const script = join(runner, "test/fixtures/topic-move-recovery.ts");
	await cp(join(import.meta.dirname, "fixtures/topic-move-recovery.ts"), script);
	await symlink(join(import.meta.dirname, "../node_modules"), join(runner, "node_modules"));
	const call = async (input: object) => decode((await execute("bun", [script, root, encode(input)])).stdout.trim());
	const sql = async (statement: string, store = "boot.db") =>
		decode(
			(await execute("bun", [join(import.meta.dirname, "fixtures/store.ts"), join(root, store), statement])).stdout,
		);
	const crash = async (pause: "rename" | "pages" | "events") => {
		const module = join(runner, "src/legacy-topic-moves.ts");
		const source = await readFile(module, "utf8");
		const marker =
			pause === "rename"
				? "yield* fs.rename(source.absolute, target.absolute);"
				: pause === "pages"
					? "// Legacy page publication is durable before event routing."
					: "// Legacy event publication is durable before retirement.";
		expect(source.split(marker)).toHaveLength(2);
		await writeFile(
			module,
			source.replace(
				marker,
				pause === "rename"
					? `${marker}\nyield* Effect.sync(() => console.log("BOUNDARY")); yield* Effect.never;`
					: `yield* Effect.sync(() => console.log("BOUNDARY")); yield* Effect.never;\n${marker}`,
			),
		);
		const child = spawn("bun", [script, root, encode({ op: "recover" })]);
		test.onTestFinished(() => {
			child.kill("SIGKILL");
		});
		let output = "";
		let error = "";
		child.stderr.on("data", (chunk: Buffer) => {
			error = (error + chunk.toString()).slice(-4096);
		});
		child.stdout.on("data", (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-4096);
		});
		await expect
			.poll(
				() => {
					if (child.exitCode !== null) throw new Error(`Early exit: ${output} ${error}`);
					return { boundary: output.includes("BOUNDARY"), stderr: error };
				},
				{ timeout: 5000 },
			)
			.toMatchObject({ boundary: true });
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		await writeFile(module, source);
	};
	return { root, call, sql, crash };
}
it("aborts a durable page intent only after authoritative app evidence proves no commit", async (test) => {
	const app = await fixture(test);
	expect(await app.call({ op: "seed" })).toMatchObject({ _tag: "Success" });
	expect(await app.call({ op: "recover" })).toMatchObject({ _tag: "Success" });
	expect(await readFile(join(app.root, "pages/old/page.md"), "utf8")).toBe("preserved");
	expect(await app.sql("SELECT name FROM sqlite_master WHERE name IN ('topic_moves','topic_page_moves')")).toEqual([]);
	expect(await app.sql("SELECT state FROM event_batches")).toEqual([{ state: "aborted" }]);
});
it.for(["rename", "pages", "events"] as const)(
	"rolls committed moves forward after SIGKILL at %s publication boundary",
	async (pause, test) => {
		const app = await fixture(test);
		expect(await app.call({ op: "seed", committed: true })).toMatchObject({ _tag: "Success" });
		await app.crash(pause);
		if (pause === "rename")
			expect(await app.sql("SELECT state FROM topic_page_moves")).toEqual([{ state: "publishing" }]);
		expect(await app.sql("SELECT name FROM sqlite_master WHERE name='topic_moves'")).toHaveLength(1);
		expect(await app.call({ op: "recover" })).toMatchObject({ _tag: "Success" });
		expect(await app.call({ op: "recover" })).toMatchObject({ _tag: "Success" });
		expect(await readFile(join(app.root, "pages/new/page.md"), "utf8")).toBe("preserved");
		expect((await stat(join(app.root, "pages/new/empty"))).isDirectory()).toBe(true);
		await expect(stat(join(app.root, "pages/old"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await app.sql("SELECT name FROM sqlite_master WHERE name IN ('topic_moves','topic_page_moves')")).toEqual(
			[],
		);
		expect((await stat(join(app.root, "pages/new/page.md"))).mode & 0o777).toBe(0o600);
		expect(await app.sql("SELECT json_extract(event,'$.payload') payload,topic FROM events WHERE seq=1")).toEqual([
			{ payload: '{"from":"old","to":"new"}', topic: "new" },
		]);
		expect(await app.sql("SELECT seq FROM events ORDER BY seq")).toEqual([{ seq: 1 }, { seq: 2 }]);
	},
);
it.for(["content", "mode", "identity", "destination"] as const)(
	"preserves a committed move with conflicting %s",
	async (kind, test) => {
		const app = await fixture(test);
		await app.call({ op: "seed", committed: true });
		if (kind === "content") await writeFile(join(app.root, "pages/old/page.md"), "external conflict");
		if (kind === "mode") await chmod(join(app.root, "pages/old/page.md"), 0o644);
		if (kind === "identity") {
			await rename(join(app.root, "pages/old"), join(app.root, "pages/saved"));
			await mkdir(join(app.root, "pages/old/empty"), { recursive: true });
			await writeFile(join(app.root, "pages/old/page.md"), "preserved");
			await chmod(join(app.root, "pages/old/page.md"), 0o600);
		}
		if (kind === "destination") await mkdir(join(app.root, "pages/new"));
		const pages = await app.sql("SELECT * FROM topic_page_moves");
		const outbox = await app.sql("SELECT * FROM outbox", "comms.db");
		const batches = await app.sql("SELECT * FROM mutation_batches", "comms.db");
		expect(await app.call({ op: "recover" })).toMatchObject({
			_tag: "Failure",
			failure: { code: "topic_move_recovery_required" },
		});
		expect(await app.sql("SELECT pending_id,published_through FROM seq")).toEqual([
			{ pending_id: "move", published_through: 0 },
		]);
		expect(await app.sql("SELECT state FROM topic_moves")).toEqual([{ state: "prepared" }]);
		expect(await app.sql("SELECT * FROM topic_page_moves")).toEqual(pages);
		expect(await app.sql("SELECT * FROM outbox", "comms.db")).toEqual(outbox);
		expect(await app.sql("SELECT * FROM mutation_batches", "comms.db")).toEqual(batches);
		expect(await app.sql("SELECT seq FROM events ORDER BY seq")).toEqual([{ seq: 2 }]);
		expect(await readFile(join(app.root, "pages/old/page.md"), "utf8")).toBe(
			kind === "content" ? "external conflict" : "preserved",
		);
	},
);

it.for(["move-table", "page-table", "orphan-page", "orphan-move"] as const)(
	"preserves ambiguous legacy evidence (%s)",
	async (kind, test) => {
		const app = await fixture(test);
		await app.call({ op: "seed", committed: true });
		if (kind === "move-table") await app.sql("DROP TABLE topic_moves");
		if (kind === "page-table") await app.sql("DROP TABLE topic_page_moves");
		if (kind === "orphan-page") await app.sql("DELETE FROM topic_moves");
		if (kind === "orphan-move") await app.sql("DELETE FROM topic_page_moves");
		const state = await app.sql("SELECT * FROM seq");
		const moves = kind === "move-table" ? null : await app.sql("SELECT * FROM topic_moves");
		const pages = kind === "page-table" ? null : await app.sql("SELECT * FROM topic_page_moves");
		const tables = await app.sql(
			"SELECT name FROM sqlite_master WHERE name IN ('topic_moves','topic_page_moves') ORDER BY name",
		);
		expect(await app.call({ op: "recover" })).toMatchObject({
			_tag: "Failure",
			failure: { code: "topic_move_recovery_required" },
		});
		expect(await app.sql("SELECT * FROM seq")).toEqual(state);
		if (moves !== null) expect(await app.sql("SELECT * FROM topic_moves")).toEqual(moves);
		if (pages !== null) expect(await app.sql("SELECT * FROM topic_page_moves")).toEqual(pages);
		expect(
			await app.sql("SELECT name FROM sqlite_master WHERE name IN ('topic_moves','topic_page_moves') ORDER BY name"),
		).toEqual(tables);
		expect(await readFile(join(app.root, "pages/old/page.md"), "utf8")).toBe("preserved");
	},
);

it("retires empty compatibility tables without opening the app store", async (test) => {
	const app = await fixture(test);
	await app.call({ op: "seed" });
	await app.sql("DELETE FROM topic_page_moves");
	await app.sql("DELETE FROM topic_moves");
	await writeFile(join(app.root, "comms.db"), "app bytes must not be opened or replaced");
	const before = await readFile(join(app.root, "comms.db"));
	expect(await app.call({ op: "recover" })).toMatchObject({ _tag: "Success" });
	expect(await readFile(join(app.root, "comms.db"))).toEqual(before);
	expect(await app.sql("SELECT name FROM sqlite_master WHERE name IN ('topic_moves','topic_page_moves')")).toEqual([]);
});

it.for(["completed-unpublished", "aborted-pending", "aborted-published"] as const)(
	"refuses contradictory terminal receipts (%s)",
	async (kind, test) => {
		const app = await fixture(test);
		await app.call({ op: "seed", committed: true });
		if (kind === "aborted-published") await app.crash("events");
		await app.sql(`UPDATE topic_moves SET state='${kind === "completed-unpublished" ? "completed" : "aborted"}',seq=1`);
		if (kind === "completed-unpublished") {
			await app.sql("UPDATE topic_page_moves SET state='completed'");
			await app.sql("UPDATE seq SET pending_id=NULL,pending_attempt=NULL,pending_from=NULL,pending_to=NULL");
		}
		if (kind === "aborted-published") await app.sql("UPDATE topic_page_moves SET state='prepared'");
		const moves = await app.sql("SELECT * FROM topic_moves");
		const pages = await app.sql("SELECT * FROM topic_page_moves");
		const seq = await app.sql("SELECT * FROM seq");
		expect(await app.call({ op: "recover" })).toMatchObject({
			_tag: "Failure",
			failure: { code: "topic_move_recovery_required" },
		});
		expect(await app.sql("SELECT * FROM topic_moves")).toEqual(moves);
		expect(await app.sql("SELECT * FROM topic_page_moves")).toEqual(pages);
		expect(await app.sql("SELECT * FROM seq")).toEqual(seq);
	},
);

it("retires a completed move only with its published single-event receipt", async (test) => {
	const app = await fixture(test);
	await app.call({ op: "seed", committed: true });
	await app.crash("events");
	await app.sql("UPDATE topic_moves SET state='completed'");
	await app.sql("UPDATE topic_page_moves SET state='completed'");
	const events = await app.sql("SELECT * FROM events ORDER BY seq");
	await writeFile(join(app.root, "pages/new/page.md"), "later page edit");
	expect(await app.call({ op: "recover" })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT * FROM events ORDER BY seq")).toEqual(events);
	expect(await readFile(join(app.root, "pages/new/page.md"), "utf8")).toBe("later page edit");
	expect(await app.sql("SELECT name FROM sqlite_master WHERE name IN ('topic_moves','topic_page_moves')")).toEqual([]);
});

it.for(["missing", "aborted", "range", "attempt"] as const)(
	"retains pages and evidence with a malformed boot reservation (%s)",
	async (kind, test) => {
		const app = await fixture(test);
		await app.call({ op: "seed", committed: kind !== "attempt" });
		if (kind === "missing") await app.sql("DELETE FROM event_batches");
		if (kind === "aborted") await app.sql("UPDATE event_batches SET state='aborted'");
		if (kind === "range") await app.sql("UPDATE event_batches SET to_seq=to_seq+1");
		if (kind === "attempt") await app.sql("UPDATE seq SET pending_attempt=NULL");
		const before = await Promise.all([
			app.sql("SELECT * FROM topic_moves"),
			app.sql("SELECT * FROM topic_page_moves"),
			app.sql("SELECT * FROM seq"),
			app.sql("SELECT * FROM event_batches"),
		]);
		expect(await app.call({ op: "recover" })).toMatchObject({
			_tag: "Failure",
			failure: { code: "topic_move_recovery_required" },
		});
		expect(
			await Promise.all([
				app.sql("SELECT * FROM topic_moves"),
				app.sql("SELECT * FROM topic_page_moves"),
				app.sql("SELECT * FROM seq"),
				app.sql("SELECT * FROM event_batches"),
			]),
		).toEqual(before);
		expect(await readFile(join(app.root, "pages/old/page.md"), "utf8")).toBe("preserved");
		await expect(stat(join(app.root, "pages/new"))).rejects.toMatchObject({ code: "ENOENT" });
	},
);
