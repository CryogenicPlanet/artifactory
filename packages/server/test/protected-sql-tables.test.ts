import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("retains protected extension tables through factory failure, source deletion and restart", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/protected.ts"),
		`import {Effect} from "effect"; import {SqlClient} from "effect/unstable/sql";
export default api => Effect.gen(function*(){
 const db = yield* SqlClient.SqlClient; yield* db.unsafe("PRAGMA foreign_keys=ON");
 yield* api.migrate("parent", "CREATE TABLE IF NOT EXISTS repair_parent(id INTEGER PRIMARY KEY)");
 yield* api.migrate("evidence", "CREATE TABLE IF NOT EXISTS extension_evidence(id INTEGER PRIMARY KEY REFERENCES repair_parent(id) ON DELETE CASCADE,value TEXT)", {protect:true});
 yield* Effect.fail(new Error("failure after durable migration"));
});`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(await (await fetch(`${app.url}/api/ext`, { headers: { cookie } })).json()).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "protected.ts", status: "disabled" })]),
	);
	await fixture.sql("INSERT INTO repair_parent VALUES(1)");
	await fixture.sql("INSERT INTO extension_evidence VALUES(1,'retained')");
	const check = async (running: typeof app) => {
		expect(
			(
				await running.post(
					"/api/sql",
					{
						sql: "CREATE TABLE IF NOT EXISTS extension_evidence_notes(value TEXT)",
					},
					cookie,
				)
			).status,
		).toBe(200);
		expect(
			(
				await running.post(
					"/api/sql",
					{
						sql: "INSERT INTO extension_evidence_notes VALUES('extension_evidence')",
					},
					cookie,
				)
			).status,
		).toBe(200);
		const editableHistory = await fixture.sql("SELECT * FROM migrations ORDER BY migration_id");
		for (const sql of [
			"DELETE FROM extension_evidence",
			'DELETE FROM main."extension_evidence"',
			"WITH selected AS (SELECT 1) DELETE FROM extension_evidence",
			"CREATE INDEX forbidden_evidence_index ON extension_evidence(value)",
			"DROP TABLE extension_evidence",
			"ALTER TABLE extension_evidence RENAME TO lost",
			"DELETE FROM protected_sql_tables",
			"DROP TABLE protected_sql_tables",
			"DELETE FROM extension_migrations",
			"DELETE FROM core_migrations",
			"DELETE FROM migrations",
			"DROP TABLE migrations",
			"UPDATE migrations SET name='changed'",
			"DROP TABLE core_migrations",
			"UPDATE webhook_subscriptions SET cursor=999",
			"DELETE FROM topic_page_continuations",
		])
			expect((await running.post("/api/sql", { sql }, cookie)).status, sql).toBe(501);
		expect(await fixture.sql("SELECT * FROM migrations ORDER BY migration_id")).toEqual(editableHistory);
		await fixture.sql(
			"CREATE TRIGGER evidence_guard AFTER UPDATE ON repair_parent BEGIN DELETE FROM extension_evidence; END",
		);
		expect((await running.post("/api/sql", { sql: "UPDATE repair_parent SET id=id" }, cookie)).status).toBe(400);
		await fixture.sql("DROP TRIGGER evidence_guard");
		await fixture.sql("CREATE INDEX retained_evidence_index ON extension_evidence(value)");
		expect((await running.post("/api/sql", { sql: "DROP INDEX retained_evidence_index" }, cookie)).status).toBe(501);
		expect(await fixture.sql("SELECT name FROM sqlite_schema WHERE name='retained_evidence_index'")).toEqual([
			{ name: "retained_evidence_index" },
		]);
		await fixture.sql("DROP INDEX retained_evidence_index");
		const ledger = await fixture.sql("SELECT migration_id,name FROM core_migrations ORDER BY migration_id");
		await fixture.sql(
			"CREATE TRIGGER ledger_guard AFTER UPDATE ON repair_parent BEGIN DELETE FROM core_migrations; END",
		);
		expect((await running.post("/api/sql", { sql: "UPDATE repair_parent SET id=id" }, cookie)).status).toBe(400);
		await fixture.sql("DROP TRIGGER ledger_guard");
		expect(await fixture.sql("SELECT migration_id,name FROM core_migrations ORDER BY migration_id")).toEqual(ledger);
		expect(await fixture.sql("SELECT * FROM extension_evidence")).toEqual([{ id: 1, value: "retained" }]);
		expect((await running.post("/api/sql", { sql: "INSERT INTO repair_parent VALUES(2)" }, cookie)).status).toBe(200);
		await fixture.sql("DELETE FROM repair_parent WHERE id=2");
	};
	expect((await app.post("/api/sql", { sql: "DELETE FROM repair_parent WHERE id=1" }, cookie)).status).toBe(400);
	expect((await app.post("/api/sql", { sql: "DROP TABLE repair_parent" }, cookie)).status).toBe(400);
	expect(await fixture.sql("SELECT id FROM repair_parent")).toEqual([{ id: 1 }]);
	await check(app);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const removed = await fetch(`${app.url}/api/fs/app/ext/protected.ts`, {
		method: "DELETE",
		headers: { cookie, origin: "https://comms.test" },
	});
	expect(await removed.json()).toMatchObject({ status: "live" });
	expect(await (await fetch(`${app.url}/api/ext`, { headers: { cookie } })).json()).not.toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "protected.ts" })]),
	);
	await check(app);
	await app.stop();
	const resumed = await fixture.launch(join(seed, "server.ts"));
	await resumed.ready(cookie);
	await check(resumed);
}, 35000);
