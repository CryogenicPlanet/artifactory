import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("inspects physical committed rows with scoped read authority and documents the bounded SQL subset", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "admission-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const marker = join(fixture.root, "reader-started");
	const worker = join(seed, "kernel/sql-read-worker.ts");
	const source = (await readFile(worker, "utf8")).replace("Console, Effect,", "Console, Effect, FileSystem,");
	const needle = "const stdio = yield* Stdio.Stdio;";
	expect(source.split(needle)).toHaveLength(2);
	await writeFile(
		worker,
		source.replace(
			needle,
			`${needle}\nyield* (yield* FileSystem.FileSystem).writeFileString(${JSON.stringify(marker)}, "started");`,
		),
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const query = (sql: string, params?: unknown[]) =>
		app.post("/api/sql", { sql, ...(params ? { params } : {}) }, cookie);
	expect((await app.post("/api/sql", { sql: "SELECT 1" })).status).toBe(401);
	for (const path of ["/api/sql?unknown=1", "/api/sql?sql=SELECT+1", "/api/sql?unknown=1&unknown=2"]) {
		const invalid = await app.post(path, { sql: "SELECT 1" }, cookie);
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({ error: { code: "query_invalid", retriable: false } });
	}
	const extra = await app.post("/api/sql", { sql: "SELECT 1", unknown: true }, cookie);
	expect(extra.status).toBe(400);
	expect(await extra.json()).toMatchObject({ error: { code: "input_invalid" } });
	const media = await fetch(`${app.url}/api/sql`, {
		method: "POST",
		headers: { cookie, origin: "https://comms.test", "content-type": "text/plain" },
		body: '{"sql":"SELECT 1"}',
	});
	expect(media.status).toBe(415);
	expect(await media.json()).toMatchObject({ error: { code: "unsupported_media_type", retriable: false } });

	const created = await (await app.post("/api/messages", { topic: "sql", body: "original" }, cookie)).json();
	// Raw inspection intentionally returns physical state, including unpublished prior-image metadata.
	await fixture.sql(`UPDATE messages SET body='physical', previous='{}', updated_seq=9000000 WHERE id='${created.id}'`);
	expect(await (await query("SELECT body, updated_seq FROM messages WHERE id=?", [created.id])).json()).toEqual({
		rows: [{ body: "physical", updated_seq: 9000000 }],
		truncated: false,
		dialect: "sqlite",
	});
	expect(await (await query("WITH value(v) AS (SELECT ?) SELECT v FROM value", [";--/*\0"])).json()).toEqual({
		rows: [{ v: ";--/*\0" }],
		truncated: false,
		dialect: "sqlite",
	});
	const enrolled = await (await app.post("/auth/enroll", { name: "sql", kind: "test", host: "read" })).json();
	const params = { id: enrolled.id, decision: "approve" as const, scopes: ["read"], long_lived: false };
	const proof = await app.assertion(params);
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrolled.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", "x-chirp-assertion": proof },
				body: JSON.stringify({ decision: params.decision, scopes: params.scopes, long_lived: false }),
			})
		).status,
	).toBe(200);
	const pair = await (await app.post(`/auth/enroll/${enrolled.id}`, { device_secret: enrolled.device_secret })).json();
	const bearerQuery = (sql: string) =>
		fetch(`${app.url}/api/sql`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${pair.access}`,
				"content-type": "application/json",
				"x-chirp-auth-kind": "human",
				"x-chirp-scopes": "read,write,fs",
			},
			body: JSON.stringify({ sql }),
		});
	expect((await bearerQuery("SELECT count(*) AS count FROM messages")).status).toBe(200);
	expect((await bearerQuery("DELETE FROM messages")).status).toBe(403);
	await fixture.sql(
		`UPDATE tokens SET scopes='["write"]' WHERE family=(SELECT family FROM tokens WHERE agent='sql' LIMIT 1)`,
		"boot.db",
	);
	await rm(marker);
	for (const sql of ["SELECT 1", "WITH value(v) AS (SELECT 1) SELECT v FROM value"])
		expect((await bearerQuery(sql)).status).toBe(403);
	await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	await fixture.sql(
		`UPDATE tokens SET scopes='["fs"]' WHERE family=(SELECT family FROM tokens WHERE agent='sql' LIMIT 1)`,
		"boot.db",
	);
	await fixture.sql("CREATE TABLE admission_write(value INTEGER)");
	expect((await bearerQuery("SELECT 1")).status).toBe(403);
	await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	expect((await bearerQuery("WITH value(v) AS (SELECT 1) SELECT v FROM value")).status).toBe(403);
	expect(await readFile(marker, "utf8")).toBe("started");
	expect(
		(await bearerQuery("WITH value(v) AS (SELECT 7) INSERT INTO admission_write SELECT v FROM value")).status,
	).toBe(200);
	expect(await fixture.sql("SELECT value FROM admission_write")).toEqual([{ value: 7 }]);
	const result = await query("SELECT 1 AS n");
	expect(result.headers.get("cache-control")).toBe("no-store");
	expect(await result.json()).toEqual({ rows: [{ n: 1 }], truncated: false, dialect: "sqlite" });
	const discovery = await (await fetch(`${app.url}/api`, { headers: { cookie } })).json();
	expect(discovery.paths["/api/sql"].post.description).toContain("physical committed");
}, 30000);

async function safetyFixture(test: TestContext) {
	const started = performance.now();
	const phase: { stage: string; sent: number; completed: number; status: number | null } = {
		stage: "fixture",
		sent: 0,
		completed: 0,
		status: null,
	};
	const evidence = () => JSON.stringify({ ...phase, elapsed_ms: Math.round(performance.now() - started) });
	let beforeCleanup: string | undefined;
	test.onTestFailed(() => console.error(`SQL HTTP failure: ${beforeCleanup ?? evidence()}`));
	const fixture = await conversation(test);
	phase.stage = "launch";
	const app = await fixture.launch();
	// Preserve the operation observed before fixture shutdown can settle a pending request.
	test.onTestFinished(() => {
		beforeCleanup = evidence();
	});
	phase.stage = "setup";
	await app.setup();
	phase.stage = "login";
	const cookie = await app.login();
	phase.stage = "ready";
	await app.ready(cookie);
	const queryInput = async (input: unknown) => {
		phase.sent++;
		phase.status = null;
		const response = await app.post("/api/sql", input, cookie);
		phase.completed++;
		phase.status = response.status;
		return response;
	};
	const query = (sql: string, params?: unknown[]) => queryInput({ sql, ...(params ? { params } : {}) });
	return { fixture, app, cookie, phase, query, queryInput };
}

it("refuses wrapper escapes, unsupported values and oversized output without modifying the app store", async (test) => {
	const { fixture, app, cookie, phase, query, queryInput } = await safetyFixture(test);
	phase.stage = "seed safety table";
	await fixture.sql("CREATE TABLE sql_safety(value INTEGER)");
	await fixture.sql("INSERT INTO sql_safety VALUES(1)");
	phase.stage = "unsupported grammar";
	for (const sql of [
		"PRAGMA writable_schema=1",
		"ATTACH '/tmp/comms-sql-escape.db' AS escaped",
		"VACUUM INTO '/tmp/comms-sql-escape.db'",
		"COMMIT",
		"INSERT OR ROLLBACK INTO sql_safety VALUES(2)",
		"CREATE TABLE rollback_conflict(value TEXT UNIQUE ON CONFLICT ROLLBACK)",
		"SELECT 1; DELETE FROM sql_safety",
		"SELECT 1) UNION ALL SELECT 2\0",
		"SELECT 1) UNION ALL SELECT 2 --",
		"SELECT 1 /* comment */",
		"SELECT ';'",
		"SELECT '--'",
	]) {
		const result = await query(sql);
		expect(result.status, sql).toBe(501);
		expect((await result.json()).error).toMatchObject({ code: "sql_unsupported", retriable: false });
	}
	phase.stage = "invalid execution and values";
	for (const sql of [
		"WITH x AS (DELETE FROM sql_safety RETURNING *) SELECT * FROM x",
		"SELECT load_extension('/tmp/nope')",
		"SELECT writefile('/tmp/nope', 'bad')",
		"SELECT 1)",
		"SELECT x'AB'",
		"SELECT 9223372036854775807 AS n",
		"SELECT 1e30 AS n",
		"SELECT 9007199254740993.0 AS n",
		"SELECT zeroblob(1)",
		"SELECT printf('%140000s','a') AS value",
	])
		expect((await query(sql)).status, sql).toBe(400);
	phase.stage = "bounded values and output";
	expect(await (await query("SELECT CAST(9223372036854775807 AS TEXT) AS n")).json()).toEqual({
		rows: [{ n: "9223372036854775807" }],
		truncated: false,
		dialect: "sqlite",
	});
	expect(await fixture.sql("SELECT * FROM sql_safety")).toEqual([{ value: 1 }]);
	const many = await (
		await query("WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<1000) SELECT v FROM n")
	).json();
	expect(many.rows).toHaveLength(200);
	expect(many.truncated).toBe(true);
	expect(many.rows.at(-1)).toEqual({ v: 200 });
	const escaped = await (
		await query(
			"SELECT 0 AS v) UNION ALL SELECT v FROM (WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<1000) SELECT v FROM n",
		)
	).json();
	expect(escaped.rows).toHaveLength(200);
	expect(escaped.truncated).toBe(true);
	phase.stage = "invalid inputs";
	for (const input of [
		{ sql: "" },
		{ sql: `SELECT '${"a".repeat(16384)}'` },
		{ sql: "SELECT ?", params: Array(101).fill(1) },
		{ sql: "SELECT ?", params: [Number.MAX_SAFE_INTEGER + 1] },
		{ sql: "SELECT ?", params: [true] },
		{ sql: "SELECT ?", params: ["a".repeat(65536)] },
	])
		expect((await queryInput(input)).status).toBe(400);
	phase.stage = "write after validation failures";
	expect((await app.post("/api/messages", { topic: "sql", body: "still writing" }, cookie)).status).toBe(200);
	phase.stage = "complete";
}, 30000);

it("keeps ordinary writes usable after thirty failed readonly executions", async (test) => {
	const { fixture, app, cookie, phase, query } = await safetyFixture(test);
	phase.stage = "seed safety table";
	await fixture.sql("CREATE TABLE sql_safety(value INTEGER)");
	await fixture.sql("INSERT INTO sql_safety VALUES(1)");
	phase.stage = "repeated execution failures";
	for (let i = 0; i < 30; i++) expect((await query("SELECT missing_column FROM sql_safety")).status).toBe(400);
	phase.stage = "verify unchanged rows";
	expect(await fixture.sql("SELECT * FROM sql_safety")).toEqual([{ value: 1 }]);
	phase.stage = "write after repeated failures";
	expect((await app.post("/api/messages", { topic: "sql", body: "still writing" }, cookie)).status).toBe(200);
	phase.stage = "complete";
}, 30000);
