import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("removes reaction routes while preserving historical rows across restart", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const read = (path: string) => fetch(`${app.url}${path}`, { headers: { cookie } });
	expect((await (await read("/api")).json()).paths).not.toHaveProperty("/api/reactions");
	expect((await read("/api/reactions?message=m_old")).status).toBe(404);
	expect((await app.post("/api/reactions", { message: "m_old", emoji: "+1" }, cookie)).status).toBe(404);
	await app.stop();
	const outcome = JSON.stringify({ message: "m_old", emoji: "+1", instance: "legacy", active: true, seq: 42 });
	// The retired receipt table exists only in v6; restart must migrate its complete outcome.
	for (const statement of [
		"DROP INDEX outbox_unshipped",
		"DROP INDEX outbox_transaction",
		"DROP TABLE idempotency",
		"CREATE TABLE idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,message_id TEXT NOT NULL,transaction_id TEXT NOT NULL,outcome TEXT,PRIMARY KEY(instance,key))",
		"CREATE TABLE topic_idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(instance,key))",
		"CREATE TABLE read_idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,topic TEXT NOT NULL,requested_seq INTEGER NOT NULL,effective_seq INTEGER NOT NULL,PRIMARY KEY(instance,key))",
		"CREATE TABLE reaction_idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,message TEXT NOT NULL,emoji TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(instance,key))",
		"INSERT INTO reactions VALUES('m_old','legacy','+1',1,0,42)",
		`INSERT INTO reaction_idempotency VALUES('legacy','key','m_old','+1','${outcome}')`,
		"ALTER TABLE messages DROP COLUMN mentions",
		"ALTER TABLE messages DROP COLUMN previous_mentions",
		"PRAGMA user_version=6",
	])
		await fixture.sql(statement);
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(await fixture.sql("SELECT * FROM reactions")).toEqual([
		{ message_id: "m_old", instance: "legacy", emoji: "+1", active: 1, previous_active: 0, updated_seq: 42 },
	]);
	expect(await fixture.sql("SELECT key,kind,outcome FROM idempotency WHERE instance='legacy'")).toEqual([
		{ key: '["legacy","reaction","key"]', kind: "reaction.added", outcome },
	]);
	expect(await fixture.sql("SELECT name FROM sqlite_master WHERE name='reaction_idempotency'")).toEqual([]);
}, 30000);
