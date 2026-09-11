import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
	const script = join(import.meta.dirname, "fixtures/topic-move-recovery.ts");
	const call = async (input: object) => decode((await execute("bun", [script, root, encode(input)])).stdout.trim());
	const sql = async (statement: string) =>
		decode(
			(await execute("bun", [join(import.meta.dirname, "fixtures/store.ts"), join(root, "boot.db"), statement])).stdout,
		);
	const crash = async (pause: "pages" | "events") => {
		const child = spawn("bun", [script, root, encode({ op: "recover", pause })]);
		test.onTestFinished(() => {
			child.kill("SIGKILL");
		});
		let output = "";
		let error = "";
		child.stderr.on("data", (chunk: Buffer) => {
			error += chunk.toString();
		});
		await new Promise<void>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", () => reject(new Error(`Early exit: ${output} ${error}`)));
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
it("aborts a durable page intent only after authoritative app evidence proves no commit", async (test) => {
	const app = await fixture(test);
	expect(await app.call({ op: "seed" })).toMatchObject({ _tag: "Success" });
	expect(await app.call({ op: "recover" })).toMatchObject({ _tag: "Success" });
	expect(await readFile(join(app.root, "pages/old/page.md"), "utf8")).toBe("preserved");
	expect(await app.sql("SELECT state FROM topic_moves")).toEqual([{ state: "aborted" }]);
	expect(await app.sql("SELECT state FROM event_batches")).toEqual([{ state: "aborted" }]);
	expect(await app.sql("SELECT id FROM topic_page_moves")).toEqual([]);
});
it.for(["pages", "events"] as const)(
	"rolls committed moves forward after SIGKILL at %s publication boundary",
	async (pause, test) => {
		const app = await fixture(test);
		expect(await app.call({ op: "seed", committed: true })).toMatchObject({ _tag: "Success" });
		await app.crash(pause);
		expect(await app.sql("SELECT state FROM topic_moves")).toEqual([
			{ state: pause === "pages" ? "pages_published" : "completed" },
		]);
		expect(await app.call({ op: "recover" })).toMatchObject({ _tag: "Success" });
		expect(await app.call({ op: "recover" })).toMatchObject({ _tag: "Success" });
		expect(await readFile(join(app.root, "pages/new/page.md"), "utf8")).toBe("preserved");
		expect((await stat(join(app.root, "pages/new/empty"))).isDirectory()).toBe(true);
		await expect(stat(join(app.root, "pages/old"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await app.sql("SELECT state,seq FROM topic_moves")).toEqual([{ state: "completed", seq: 1 }]);
		expect(await app.sql("SELECT state FROM topic_page_moves")).toEqual([{ state: "completed" }]);
		expect(await app.sql("SELECT seq FROM events ORDER BY seq")).toEqual([{ seq: 1 }, { seq: 2 }]);
	},
);
it("holds committed app evidence unpublished when the captured page tree conflicts", async (test) => {
	const app = await fixture(test);
	await app.call({ op: "seed", committed: true });
	await writeFile(join(app.root, "pages/old/page.md"), "external conflict");
	expect(await app.call({ op: "recover" })).toMatchObject({
		_tag: "Failure",
		failure: { code: "topic_move_recovery_required" },
	});
	expect(await app.sql("SELECT pending_id,published_through FROM seq")).toEqual([
		{ pending_id: "move", published_through: 0 },
	]);
	expect(await app.sql("SELECT state FROM topic_moves")).toEqual([{ state: "prepared" }]);
	expect(await app.sql("SELECT seq FROM events ORDER BY seq")).toEqual([{ seq: 2 }]);
});
