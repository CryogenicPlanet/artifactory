import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";
const execute = promisify(execFile);

it("runs actual message/read/context routes and rolls back every probe row without publishing its events", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	for (const table of ["messages", "topics", "idempotency"])
		expect(await fixture.sql(`SELECT COUNT(*) count FROM ${table}`)).toEqual([{ count: 0 }]);
	await expect
		.poll(() =>
			fixture.sql("SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='ext.loaded'", "boot.db"),
		)
		.toEqual([{ count: 1 }]);
	expect(
		await fixture.sql("SELECT COUNT(*) count FROM outbox WHERE json_extract(event,'$.type')<>'ext.loaded'"),
	).toEqual([{ count: 0 }]);
	expect(await fixture.sql("SELECT COUNT(*) count FROM mutation_batches WHERE id NOT LIKE 'ext:%'")).toEqual([
		{ count: 0 },
	]);
	expect(await fixture.sql("SELECT state FROM event_batches WHERE state='aborted'", "boot.db")).toEqual([
		{ state: "aborted" },
	]);
	expect(
		await fixture.sql("SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')<>'ext.loaded'", "boot.db"),
	).toEqual([{ count: 0 }]);
	const posted = await app.post("/api/messages", { topic: "after-health", body: "ordinary writes publish" }, cookie);
	expect(posted.status).toBe(200);
	expect(await fixture.sql("SELECT COUNT(*) count FROM messages")).toEqual([{ count: 1 }]);
}, 20000);

for (const kind of ["create", "read", "context"])
	it(`rejects a broken actual ${kind} route even when it returns HTTP 200`, async (test) => {
		const fixture = await conversation(test);
		const seed = join(fixture.root, "seed");
		await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
		const source = join(seed, kind === "context" ? "context.ts" : "conversation.ts");
		const before = await readFile(source, "utf8");
		const anchor =
			kind === "create"
				? 'const who = yield* identity("write");'
				: kind === "read"
					? 'const who = yield* identity("read");'
					: "return HttpServerResponse.text(text, {";
		const replacement =
			kind === "context"
				? "return HttpServerResponse.text(`# ${topic}`, {"
				: "return HttpServerResponse.jsonUnsafe({ items: [] });";
		expect(before).toContain(anchor);
		await writeFile(source, before.replace(anchor, replacement));
		const app = await fixture.launch(join(seed, "server.ts"));
		await app.setup();
		const cookie = await app.login();
		await expect
			.poll(
				async () => {
					const value = await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
					return value.child.state;
				},
				{ timeout: 20000 },
			)
			.toBe("failed");
		for (const table of ["messages", "topics", "outbox", "mutation_batches", "idempotency"])
			expect(await fixture.sql(`SELECT COUNT(*) count FROM ${table}`)).toEqual([{ count: 0 }]);
		expect(await fixture.sql("SELECT COUNT(*) count FROM events", "boot.db")).toEqual([{ count: 0 }]);
	}, 25000);

it("rehearses a WAL-inclusive SQLite clone without changing live rows, epoch or sequence allocator", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await expect
		.poll(() =>
			fixture.sql("SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='ext.loaded'", "boot.db"),
		)
		.toEqual([{ count: 1 }]);
	expect((await app.post("/api/messages", { topic: "wal", body: "committed WAL data" }, cookie)).status).toBe(200);
	expect((await stat(join(fixture.root, "comms.db-wal"))).size).toBeGreaterThan(32);
	await cp(join(fixture.root, "comms.db"), join(fixture.root, "main-only.db"));
	const mainOnly = await fixture.sql("SELECT body FROM messages", "main-only.db").catch(() => []);
	expect(mainOnly).not.toEqual([{ body: "committed WAL data" }]);
	const before = await fixture.sql("SELECT * FROM kernel_writer");
	const sequence = await fixture.sql("SELECT * FROM seq", "boot.db");
	const { stdout } = await execute("bun", [join(import.meta.dirname, "fixtures/rehearsal.ts")], {
		env: {
			...process.env,
			LIVE_DATABASE: join(fixture.root, "comms.db"),
			REHEARSAL_ENTRY: join(import.meta.dirname, "../src/server.ts"),
		},
	});
	expect(JSON.parse(stdout)).toMatchObject({ status: 200, rows: [{ body: "committed WAL data" }] });
	expect(await fixture.sql("SELECT * FROM kernel_writer")).toEqual(before);
	expect(await fixture.sql("SELECT * FROM seq", "boot.db")).toEqual(sequence);
	expect(await fixture.sql("SELECT body FROM messages")).toEqual([{ body: "committed WAL data" }]);
}, 20000);
