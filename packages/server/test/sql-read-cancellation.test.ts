import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it.for(["timeout", "disconnect", "boot death"] as const)(
	"closes a readonly SQL process after %s without losing acknowledged writes",
	{ timeout: 30000 },
	async (mode, test) => {
		const fixture = await conversation(test);
		const seed = join(fixture.root, "sql-reader-seed");
		await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
		const marker = join(fixture.root, "sql-reader-pid");
		const worker = join(seed, "kernel/sql-read-worker.ts");
		const source = (await readFile(worker, "utf8")).replace("Console, Effect,", "Console, Effect, FileSystem,");
		const needle = "const stdio = yield* Stdio.Stdio;";
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			worker,
			source.replace(
				needle,
				`${needle}\nyield* (yield* FileSystem.FileSystem).writeFileString(${JSON.stringify(marker)},String(process.pid));`,
			),
		);
		const app = await fixture.launch(join(seed, "server.ts"));
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		const status = async () => (await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()).child;
		const initial = await status();
		const original = await (
			await app.post("/api/messages", { topic: "sql-timeout", body: "before query" }, cookie, "before")
		).json();
		const controller = new AbortController();
		test.onTestFinished(() => controller.abort());
		const pending = fetch(`${app.url}/api/sql`, {
			method: "POST",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
			body: JSON.stringify({
				sql: "WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n) SELECT sum(v) FROM n",
			}),
			signal: controller.signal,
		}).then(
			async (response) => ({ status: response.status, body: await response.json() }),
			() => null,
		);
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		let pid = 0;
		await expect
			.poll(
				async () => {
					pid = Number(await readFile(marker, "utf8").catch(() => "0"));
					return pid > 0;
				},
				{ timeout: 3000 },
			)
			.toBe(true);
		expect(alive(pid)).toBe(true);
		// Other application work remains responsive while SQLite is executing native code.
		expect((await app.post("/api/messages", { topic: "sql-timeout", body: "during query" }, cookie)).status).toBe(200);
		if (mode === "disconnect") controller.abort();
		if (mode === "boot death") await app.stop("SIGKILL");
		const result = await pending;
		if (mode === "timeout")
			expect(result).toMatchObject({ status: 408, body: { error: { code: "sql_query_timeout", retriable: false } } });
		else expect(result).toBeNull();
		await expect.poll(() => alive(pid), { timeout: 3000 }).toBe(false);
		if (mode !== "boot death") expect(await status()).toEqual(initial);
		const current = mode === "boot death" ? await fixture.launch(join(seed, "server.ts")) : app;
		await current.ready(cookie);
		expect(
			await (
				await current.post("/api/messages", { topic: "sql-timeout", body: "before query" }, cookie, "before")
			).json(),
		).toEqual(original);
		expect(await fixture.sql("SELECT body FROM messages WHERE topic='sql-timeout' ORDER BY seq")).toEqual([
			{ body: "before query" },
			{ body: "during query" },
		]);
		expect((await current.post("/api/sql", { sql: "SELECT 1 AS n" }, cookie)).status).toBe(200);
	},
);

it("keeps direct writes and durable replays available with both readers occupied", { timeout: 30000 }, async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "saturated-reader-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const marker = join(fixture.root, "readers");
	const worker = join(seed, "kernel/sql-read-worker.ts");
	const source = (await readFile(worker, "utf8")).replace("Console, Effect,", "Console, Effect, FileSystem,");
	const needle = "const stdio = yield* Stdio.Stdio;";
	expect(source.split(needle)).toHaveLength(2);
	await writeFile(
		worker,
		source.replace(
			needle,
			`${needle}\nyield* (yield* FileSystem.FileSystem).writeFileString(${JSON.stringify(marker)} + process.pid, "started");`,
		),
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/sql", { sql: "CREATE TABLE reader_writes(value TEXT)" }, cookie)).status).toBe(200);
	const input = { sql: "INSERT INTO reader_writes VALUES ('once')" };
	const original = await (await app.post("/api/sql", input, cookie, "write-once")).json();
	const controller = new AbortController();
	test.onTestFinished(() => controller.abort());
	let completed = 0;
	const pending = Array.from({ length: 2 }, () =>
		fetch(`${app.url}/api/sql`, {
			method: "POST",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
			body: JSON.stringify({
				sql: "WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n) SELECT sum(v) FROM n",
			}),
			signal: controller.signal,
		})
			.catch(() => null)
			.finally(() => {
				completed++;
			}),
	);
	await expect
		.poll(async () => (await readdir(fixture.root)).filter((name) => name.startsWith("readers")).length, {
			timeout: 3000,
		})
		.toBe(2);
	expect(await (await app.post("/api/sql", input, cookie, "write-once")).json()).toEqual(original);
	expect((await app.post("/api/sql", { sql: "INSERT INTO reader_writes VALUES ('during')" }, cookie)).status).toBe(200);
	expect(completed).toBe(0);
	controller.abort();
	await Promise.all(pending);
	expect(await fixture.sql("SELECT value FROM reader_writes ORDER BY rowid")).toEqual([
		{ value: "once" },
		{ value: "during" },
	]);
});
