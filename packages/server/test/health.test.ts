import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";
const execute = promisify(execFile);

it("runs actual message/read/topic routes and rolls back every probe row without publishing its events", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(await fixture.sql("SELECT COUNT(*) count FROM messages WHERE instance<>'extension:system.ts'")).toEqual([
		{ count: 0 },
	]);
	expect(await fixture.sql("SELECT COUNT(*) count FROM topics WHERE path<>'system'")).toEqual([{ count: 0 }]);
	await expect
		.poll(() =>
			fixture.sql("SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='ext.loaded'", "boot.db"),
		)
		.toEqual([{ count: 4 }]);
	expect(
		await fixture.sql(
			"SELECT COUNT(*) count FROM outbox WHERE json_extract(event,'$.instance') IS NOT 'extension:system.ts' AND json_extract(event,'$.type') NOT IN ('ext.loaded','pages.public')",
		),
	).toEqual([{ count: 0 }]);
	expect(
		await fixture.sql(
			"SELECT COUNT(*) count FROM idempotency WHERE instance<>'extension:system.ts' AND kind NOT IN ('ext.loaded','pages.public')",
		),
	).toEqual([{ count: 0 }]);
	expect(
		await fixture.sql(
			"SELECT COUNT(*) count FROM mutation_batches WHERE NOT EXISTS (SELECT 1 FROM idempotency WHERE (kind IN ('ext.loaded','pages.public') OR instance='extension:system.ts') AND (CASE WHEN kind='pages.public' THEN json_extract(outcome,'$') ELSE json_extract(outcome,'$.seq') END) BETWEEN mutation_batches.from_seq AND mutation_batches.to_seq)",
		),
	).toEqual([{ count: 0 }]);
	expect(await fixture.sql("SELECT state FROM event_batches WHERE state='aborted'", "boot.db")).toEqual([
		{ state: "aborted" },
	]);
	expect(
		await fixture.sql(
			"SELECT type FROM events WHERE instance IS NOT 'extension:system.ts' AND type NOT IN ('ext.loaded','pages.public','http.request','seq.reserved') ORDER BY seq",
			"boot.db",
		),
	).toEqual([{ type: "generation.starting" }, { type: "generation.live" }]);
	const posted = await app.post("/api/messages", { topic: "after-health", body: "ordinary writes publish" }, cookie);
	expect(posted.status).toBe(200);
	expect(await fixture.sql("SELECT COUNT(*) count FROM messages WHERE instance<>'extension:system.ts'")).toEqual([
		{ count: 1 },
	]);
}, 20000);

for (const kind of ["create", "read", "topic"])
	it(`rejects a broken actual ${kind} route even when it returns HTTP 200`, async (test) => {
		const fixture = await conversation(test);
		const seed = join(fixture.root, "seed");
		await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
		const source = join(seed, kind === "topic" ? "ext/core/topics-http.ts" : "ext/core/api.ts");
		const before = await readFile(source, "utf8");
		const anchor =
			kind === "create"
				? 'const ctx = yield* extension.context("write");'
				: kind === "read"
					? 'const ctx = yield* extension.context("read");'
					: "return result;";
		const replacement =
			kind === "topic" ? "return { ...result, messages: [] };" : "return HttpServerResponse.jsonUnsafe({ items: [] });";
		expect(before).toContain(anchor);
		await writeFile(source, before.replace(anchor, replacement));
		const app = await fixture.launch(join(seed, "server.ts"));
		await app.setup();
		const cookie = await app.login();
		// Failed is also visible between retries; inspect rollback only after all three attempts finish.
		await expect
			.poll(
				async () => {
					const value = await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
					return { state: value.child.state, attempt: value.child.attempt };
				},
				{ timeout: 20000 },
			)
			.toEqual({ state: "failed", attempt: 3 });
		for (const table of ["messages", "topics", "outbox", "mutation_batches", "idempotency"])
			expect(await fixture.sql(`SELECT COUNT(*) count FROM ${table}`)).toEqual([{ count: 0 }]);
		expect(
			await fixture.sql(
				"SELECT type FROM events WHERE type NOT IN ('http.request','seq.reserved') ORDER BY seq",
				"boot.db",
			),
		).toEqual([
			{ type: "generation.starting" },
			{ type: "generation.failed" },
			{ type: "generation.starting" },
			{ type: "generation.failed" },
			{ type: "generation.starting" },
			{ type: "generation.failed" },
		]);
		expect(
			await fixture.sql(
				"SELECT json_extract(event,'$.payload.reason') AS reason, json_extract(event,'$.payload.attempts') AS attempts FROM events WHERE type='generation.failed' ORDER BY seq DESC LIMIT 1",
				"boot.db",
			),
		).toEqual([{ reason: "startup_failures", attempts: 3 }]);
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
		.toEqual([{ count: 4 }]);
	expect((await app.post("/api/messages", { topic: "wal", body: "committed WAL data" }, cookie)).status).toBe(200);
	expect((await stat(join(fixture.root, "comms.db-wal"))).size).toBeGreaterThan(32);
	await cp(join(fixture.root, "comms.db"), join(fixture.root, "main-only.db"));
	const mainOnly = await fixture.sql("SELECT body FROM messages", "main-only.db").catch(() => []);
	expect(mainOnly).not.toEqual(expect.arrayContaining([{ body: "committed WAL data" }]));
	await expect
		.poll(async () => {
			const cursor = await fixture.sql("SELECT seq FROM system_cursor WHERE id=1");
			const published = await fixture.sql("SELECT published_through AS seq FROM seq", "boot.db");
			return JSON.stringify(cursor) === JSON.stringify(published);
		})
		.toBe(true);
	const originalRows = await fixture.sql("SELECT body FROM messages ORDER BY seq");
	expect(originalRows).toEqual(expect.arrayContaining([{ body: "committed WAL data" }]));
	const before = await fixture.sql("SELECT * FROM kernel_writer");
	const sequence = await fixture.sql("SELECT * FROM seq", "boot.db");
	const { stdout } = await execute("bun", [join(import.meta.dirname, "fixtures/rehearsal.ts")], {
		env: {
			...process.env,
			LIVE_DATABASE: join(fixture.root, "comms.db"),
			REHEARSAL_ENTRY: join(import.meta.dirname, "../src/server.ts"),
		},
	});
	expect(JSON.parse(stdout)).toMatchObject({ status: 200, rows: originalRows });
	expect(await fixture.sql("SELECT * FROM kernel_writer")).toEqual(before);
	expect(await fixture.sql("SELECT * FROM seq", "boot.db")).toEqual(sequence);
	expect(await fixture.sql("SELECT body FROM messages ORDER BY seq")).toEqual(originalRows);
}, 20000);
