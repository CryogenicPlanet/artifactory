import { Clock, Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("repairs app rows/schema with fs authority and preserves first SQL outcomes across concurrent retries and restart", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const query = (sql: string, params: unknown[] = [], key?: string) =>
		app.post("/api/sql", { sql, params }, cookie, key);
	const created = await app.post(
		"/api/sql",
		{ sql: "CREATE TABLE repair(id INTEGER PRIMARY KEY,value TEXT UNIQUE)" },
		cookie,
		"create",
	);
	expect(created.status).toBe(200);
	const schemaOutcome = await created.json();
	expect(schemaOutcome).toMatchObject({ rows: [], truncated: false, changes: 0 });
	expect(
		await (await query("CREATE TABLE repair(id INTEGER PRIMARY KEY,value TEXT UNIQUE)", [], "create")).json(),
	).toEqual(schemaOutcome);
	const writeStarted = await Effect.runPromise(Clock.currentTimeMillis);
	const text = "private-bound-value;--";
	const statements = await Promise.all(
		Array.from({ length: 6 }, () => query("INSERT INTO repair(value) VALUES(?) RETURNING id,value", [text], "insert")),
	);
	const first = await statements[0]?.json();
	expect(first).toMatchObject({ rows: [{ id: 1, value: text }], changes: 1, truncated: false });
	for (const response of statements.slice(1)) {
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(first);
	}
	expect((await query("INSERT INTO repair(value) VALUES(?) RETURNING id,value", ["other"], "insert")).status).toBe(409);
	expect((await app.post("/api/messages", { topic: "sql", body: "conflict" }, cookie, "insert")).status).toBe(409);
	expect((await app.post("/api/messages", { topic: "sql", body: "first" }, cookie, "message-key")).status).toBe(200);
	expect((await query("INSERT INTO repair(value) VALUES(?)", ["conflict"], "message-key")).status).toBe(409);
	const receipt = await fixture.sql(
		"SELECT expires_at FROM idempotency WHERE kind='sql.write' AND key='[\"key\",\"insert\"]'",
	);
	const receiptRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ expires_at: Schema.Int })))(receipt);
	const expiresAt = receiptRows[0]?.expires_at ?? 0;
	expect(expiresAt).toBeGreaterThanOrEqual(writeStarted + 30 * 24 * 60 * 60 * 1000);
	expect(expiresAt).toBeLessThanOrEqual((await Effect.runPromise(Clock.currentTimeMillis)) + 30 * 24 * 60 * 60 * 1000);
	expect((await query("INSERT INTO repair(value) VALUES(?) RETURNING id,value", [text], "insert")).status).toBe(200);
	expect(
		await fixture.sql("SELECT expires_at FROM idempotency WHERE kind='sql.write' AND key='[\"key\",\"insert\"]'"),
	).toEqual(receipt);
	const updated = await query(
		"WITH desired(v) AS (SELECT ?) UPDATE repair SET value=(SELECT v FROM desired) WHERE id=1 RETURNING id,value",
		["new"],
		"update",
	);
	expect(updated.status).toBe(200);
	expect(await updated.json()).toMatchObject({ rows: [{ id: 1, value: "new" }], changes: 1 });
	const readCte = await query("WITH desired(v) AS (SELECT value FROM repair) SELECT v FROM desired");
	expect(await readCte.json()).toEqual({ rows: [{ v: "new" }], truncated: false, dialect: "sqlite" });
	const events = await (await fetch(`${app.url}/api/events?since=0&types=sql.write`, { headers: { cookie } })).json();
	expect(events.items).toHaveLength(3);
	expect(events.items.find((item: { seq: number }) => item.seq === first.seq)).toMatchObject({
		actor: "rahul",
		type: "sql.write",
		payload: { operation: "INSERT", changes: 1, parameter_count: 1 },
	});
	expect(JSON.stringify(events)).not.toContain(text);
	expect(JSON.stringify(events)).not.toContain("INSERT INTO repair");
	expect((await query("ALTER TABLE repair ADD COLUMN extra TEXT", [], "alter")).status).toBe(200);
	expect((await query("CREATE INDEX repair_value ON repair(value)", [], "index")).status).toBe(200);
	expect((await query("DROP INDEX repair_value", [], "drop-index")).status).toBe(200);
	const enrollment = await (await app.post("/auth/enroll", { name: "fs-only", kind: "test", host: "sql" })).json();
	const proof = await app.assertion({ id: enrollment.id, decision: "approve", scopes: ["fs"], long_lived: false });
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", "x-chirp-assertion": proof },
				body: JSON.stringify({ decision: "approve", scopes: ["fs"], long_lived: false }),
			})
		).status,
	).toBe(200);
	const pair = await (
		await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })
	).json();
	const asFs = (sql: string) =>
		fetch(`${app.url}/api/sql`, {
			method: "POST",
			headers: { authorization: `Bearer ${pair.access}`, "content-type": "application/json" },
			body: JSON.stringify({ sql }),
		});
	expect((await asFs("SELECT * FROM repair")).status).toBe(403);
	expect((await asFs("UPDATE repair SET extra='agent' WHERE id=1")).status).toBe(200);
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(
		await (
			await resumed.post(
				"/api/sql",
				{ sql: "INSERT INTO repair(value) VALUES(?) RETURNING id,value", params: [text] },
				cookie,
				"insert",
			)
		).json(),
	).toEqual(first);
	expect(await fixture.sql("SELECT value,extra FROM repair")).toEqual([{ value: "new", extra: "agent" }]);
	const writeWith = "WITH value(v) AS (SELECT ?) INSERT INTO repair(value) SELECT v FROM value RETURNING value";
	const withResult = await resumed.post("/api/sql", { sql: writeWith, params: ["with"] }, cookie, "with-insert");
	expect(withResult.status).toBe(200);
	const withOutcome = await withResult.json();
	expect((await resumed.post("/api/sql", { sql: "DROP TABLE repair" }, cookie)).status).toBe(200);
	const replay = await resumed.post("/api/sql", { sql: writeWith, params: ["with"] }, cookie, "with-insert");
	expect(replay.status).toBe(200);
	expect(await replay.json()).toEqual(withOutcome);
}, 30000);

it("rolls back domain changes, retry receipts and events on guard, constraint and result failures", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const query = (sql: string, params: unknown[] = [], key?: string) =>
		app.post("/api/sql", { sql, params }, cookie, key);
	expect((await query("CREATE TABLE repair(value INTEGER UNIQUE)")).status).toBe(200);
	expect((await query("INSERT INTO repair VALUES(1)", [], "seed")).status).toBe(200);
	for (const [sql, params] of [
		["SELECT ? + ?", [1]],
		["SELECT ?1", [1, 2]],
		["INSERT INTO repair VALUES(?)", [2, 3]],
	] as const) {
		const failed = await query(sql, [...params], "binding");
		expect(failed.status).toBe(400);
		expect((await failed.json()).error).toMatchObject({ code: "sql_query_invalid", retriable: false });
	}
	const before = await fixture.sql("SELECT seq,event FROM events WHERE type='sql.write' ORDER BY seq", "boot.db");
	// Extension activation can publish unrelated operational receipts after readiness.
	const receipts = await fixture.sql(
		"SELECT * FROM idempotency WHERE key NOT LIKE '[\"operational\",%' ORDER BY instance,key",
	);
	for (const sql of [
		"DELETE FROM outbox",
		"DELETE FROM topic_page_continuations",
		"DROP INDEX topic_page_continuations_pending",
		"UPDATE [kernel_writer] SET epoch='bad'",
		"UPDATE store_identity SET store_id='foreign'",
		"DROP TABLE store_identity",
		'DROP TABLE "mutation_batches"',
		"ALTER TABLE idempotency RENAME TO gone",
		"DROP INDEX outbox_unshipped",
		"DROP INDEX idempotency_expiry",
		"CREATE TRIGGER malicious AFTER UPDATE ON repair BEGIN SELECT 1 END",
		"SAVEPOINT user_transaction",
		"ROLLBACK",
		"DETACH main",
		"PRAGMA writable_schema=1",
		"ATTACH '/tmp/not-created-by-comms.db' AS other",
		"BEGIN",
		"COMMIT",
		"CREATE TEMP TABLE temporary_data(x)",
		"DROP TRIGGER something",
		"INSERT INTO repair VALUES(2); DELETE FROM repair",
		"WITH x AS(SELECT 1) UPDATE repair SET value=2\0",
	])
		expect((await query(sql)).status, sql).toBe(501);
	for (const statement of [
		"INSERT INTO outbox VALUES(9999999,'forged','{}',NULL)",
		"INSERT INTO mutation_batches VALUES('forged',9999999,9999999,1)",
		"INSERT INTO idempotency VALUES('forged','forged','forged','forged','{}',9999999999999)",
		"UPDATE kernel_writer SET epoch='forged'",
		"INSERT INTO topic_page_continuations VALUES(9999999,'source','target','forged',0)",
	]) {
		await fixture.sql(`CREATE TRIGGER accidental_bookkeeping AFTER UPDATE ON repair BEGIN ${statement}; END`);
		expect((await query("UPDATE repair SET value=2", [], "guarded")).status).toBe(400);
		await fixture.sql("DROP TRIGGER accidental_bookkeeping");
		expect(await fixture.sql("SELECT * FROM repair")).toEqual([{ value: 1 }]);
		expect(await fixture.sql("SELECT * FROM topic_page_continuations")).toEqual([]);
		expect(await fixture.sql("SELECT seq,event FROM events WHERE type='sql.write' ORDER BY seq", "boot.db")).toEqual(
			before,
		);
		expect(
			await fixture.sql("SELECT * FROM idempotency WHERE key NOT LIKE '[\"operational\",%' ORDER BY instance,key"),
		).toEqual(receipts);
	}
	for (const sql of [
		"INSERT INTO repair VALUES(1)",
		"UPDATE repair SET value=2 RETURNING x'AB'",
		"UPDATE repair SET value=2 RETURNING 9223372036854775807",
		"UPDATE repair SET value=2 RETURNING printf('%140000s','x')",
	]) {
		expect((await query(sql, [], "failed")).status, sql).toBe(400);
		expect(await fixture.sql("SELECT * FROM repair")).toEqual([{ value: 1 }]);
		expect(
			await fixture.sql("SELECT * FROM idempotency WHERE key NOT LIKE '[\"operational\",%' ORDER BY instance,key"),
		).toEqual(receipts);
	}
	// Guard failures and rolled-back receipts do not prevent a corrected request from using the same key.
	expect((await query("UPDATE repair SET value=2 RETURNING value", [], "guarded")).status).toBe(200);
	const unchanged = await query("DELETE FROM repair WHERE value=999", [], "failed");
	expect(unchanged.status).toBe(200);
	expect(await unchanged.json()).toMatchObject({ rows: [], truncated: false, changes: 0, seq: expect.any(Number) });
	expect((await app.post("/api/messages", { topic: "sql", body: "normal writes continue" }, cookie)).status).toBe(200);
}, 30000);

it("counts trigger writes and rolls back indirect view changes to recovery records", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const query = (sql: string, params: unknown[] = [], key?: string) =>
		app.post("/api/sql", { sql, params }, cookie, key);
	await fixture.sql("CREATE TABLE repair(id INTEGER PRIMARY KEY,value TEXT)");
	await fixture.sql("CREATE TABLE audit(value TEXT)");
	await fixture.sql(
		"CREATE TRIGGER domain_audit AFTER INSERT ON repair BEGIN INSERT INTO audit VALUES(new.value); END",
	);
	const inserted = await query("INSERT INTO repair(id,value) VALUES(?2,?1) RETURNING id,value", ["bound", 7]);
	expect(inserted.status).toBe(200);
	expect(await inserted.json()).toMatchObject({ rows: [{ id: 7, value: "bound" }], truncated: false, changes: 2 });
	const repeated = await query("UPDATE repair SET value=?1 WHERE id=?2 RETURNING value || ?1 AS repeated", ["x", 7]);
	expect(repeated.status).toBe(200);
	expect(await repeated.json()).toMatchObject({ rows: [{ repeated: "xx" }], changes: 1 });
	expect(await fixture.sql("SELECT * FROM audit")).toEqual([{ value: "bound" }]);
	const many = await query(
		"WITH RECURSIVE n(v) AS (SELECT 100 UNION ALL SELECT v+1 FROM n WHERE v<300) INSERT INTO repair(id,value) SELECT v,'bulk' FROM n RETURNING id",
	);
	expect(many.status).toBe(200);
	const manyResult = await many.json();
	expect(manyResult).toMatchObject({ changes: 402, truncated: true });
	expect(manyResult.rows).toHaveLength(200);
	expect(await fixture.sql("SELECT count(*) AS count FROM repair")).toEqual([{ count: 202 }]);
	await fixture.sql("CREATE VIEW repair_view AS SELECT * FROM repair");
	await fixture.sql("CREATE TRIGGER view_write INSTEAD OF UPDATE ON repair_view BEGIN DELETE FROM kernel_writer; END");
	const writer = await fixture.sql("SELECT epoch FROM kernel_writer");
	const viaView = await query("UPDATE repair_view SET value='bad'");
	expect(viaView.status).toBe(400);
	expect(await viaView.json()).toMatchObject({ error: { code: "sql_query_invalid", retriable: false } });
	expect(await fixture.sql("SELECT epoch FROM kernel_writer")).toEqual(writer);
	expect((await app.post("/api/messages", { topic: "sql", body: "still live" }, cookie)).status).toBe(200);
}, 30000);
