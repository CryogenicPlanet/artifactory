import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("migrates schema v1 preserving existing conversation and idempotency records", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const input = { topic: "preserved/thread", body: "existing" };
	const existing = await (await app.post("/api/messages", input, cookie, "existing-key")).json();
	await app.stop();
	// Reconstruct v1 receipts from the persisted create result before removing newer columns.
	for (const statement of [
		"ALTER TABLE idempotency RENAME TO idempotency_v7",
		"CREATE TABLE idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,message_id TEXT NOT NULL,transaction_id TEXT NOT NULL,PRIMARY KEY(instance,key))",
		`INSERT INTO idempotency SELECT m.instance,'existing-key',json_object('topic',m.topic,'body',m.body,'tags',json(m.tags),'meta',json(m.meta)),m.id,b.id FROM messages m JOIN mutation_batches b ON m.seq BETWEEN b.from_seq AND b.to_seq JOIN idempotency_v7 i ON json_extract(i.outcome,'$.id')=m.id WHERE i.key='["key","existing-key"]'`,
		"DROP TABLE idempotency_v7",
		"DROP TRIGGER messages_fts_insert",
		"DROP TRIGGER messages_fts_update",
		"DROP TRIGGER messages_fts_delete",
		"DROP TABLE messages_fts",
		"DROP TABLE IF EXISTS agents",
		"DROP TABLE kv",
		"DROP TABLE IF EXISTS reactions",
		"ALTER TABLE topics DROP COLUMN archived_at",
		"ALTER TABLE topics DROP COLUMN deleted_at",
		"ALTER TABLE topics DROP COLUMN updated_seq",
		"ALTER TABLE topics DROP COLUMN previous",
		"ALTER TABLE messages DROP COLUMN edited_at",
		"ALTER TABLE messages DROP COLUMN deleted_at",
		"ALTER TABLE messages DROP COLUMN updated_seq",
		"ALTER TABLE messages DROP COLUMN previous",
		"DROP TABLE reads",
		"ALTER TABLE messages DROP COLUMN mentions",
		"ALTER TABLE messages DROP COLUMN previous_mentions",
		"DROP INDEX IF EXISTS outbox_unshipped",
		"DROP INDEX IF EXISTS outbox_transaction",
		"DROP TABLE topic_page_continuations",
		"DROP TABLE IF EXISTS core_migrations",
		"PRAGMA user_version=1",
	])
		await fixture.sql(statement);
	expect(await fixture.sql("PRAGMA user_version")).toEqual([{ user_version: 1 }]);
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	const root = await (await fetch(resumed.url + "/api/topics?mark=0", { headers: { cookie } })).json();
	expect(root.messages.filter((message: { topic: string }) => message.topic !== "system")).toEqual([existing]);
	expect(await (await resumed.post("/api/messages", input, cookie, "existing-key")).json()).toEqual(existing);
	expect(await fixture.sql("PRAGMA user_version")).toEqual([{ user_version: 10 }]);
	expect(await fixture.sql("SELECT migration_id,name FROM core_migrations ORDER BY migration_id")).toEqual(
		[
			"messages",
			"reads",
			"message_edits",
			"topic_edits_search",
			"agents_kv",
			"topic_deletion",
			"idempotency_mentions",
			"topic_page_continuations",
			"mention_word_boundaries",
			"mention_punctuation",
		].map((name, index) => ({ migration_id: index + 1, name })),
	);
	expect(await fixture.sql("SELECT archived_at FROM topics WHERE path<>'system'")).toEqual([
		{ archived_at: null },
		{ archived_at: null },
	]);
}, 30000);

it("lists all children even beyond the recent-message window", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	for (let i = 0; i < 205; i++)
		expect((await app.post("/api/messages", { topic: `many/child-${i}`, body: `message ${i}` }, cookie)).status).toBe(
			200,
		);
	const root = await (await fetch(app.url + "/api/topics?mark=0", { headers: { cookie } })).json();
	expect(root.messages).toHaveLength(100);
	expect(root.messages[0].body).toBe("message 105");
	expect(root.messages.at(-1).body).toBe("message 204");
	const topic = await (await fetch(app.url + "/api/topics/many", { headers: { cookie } })).json();
	expect(topic.subtopics).toHaveLength(205);
	expect(topic.unread).toBe(205);
	expect(topic.subtopics[0].path).toBe("many/child-204");
}, 30000);

it("decodes canonical and legacy topic paths once and distinguishes invalid paths from queries", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "notes/nested", body: "path boundary" }, cookie)).status).toBe(200);
	for (const path of ["notes%2Fnested", "notes/nested"]) {
		const response = await fetch(app.url + `/api/topics/${path}?mark=0`, { headers: { cookie } });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ path: "notes/nested", messages: [{ body: "path boundary" }] });
	}
	for (const path of ["notes%252Fnested", "notes/100%25-done", "100%25-done", "notes/Uppercase", "Uppercase"]) {
		for (const method of ["GET", "PUT"]) {
			const response = await fetch(app.url + `/api/topics/${path}`, {
				method,
				headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
				...(method === "PUT" ? { body: JSON.stringify({ meta: {} }) } : {}),
			});
			expect(response.status, `${method} ${path}`).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: "input_invalid", retriable: false } });
		}
	}
	// The outer router rejects malformed URL escapes before either handler runs.
	for (const method of ["GET", "PUT"]) {
		const response = await fetch(app.url + "/api/topics/notes/100%-done", {
			method,
			headers: { cookie, origin: "https://comms.test" },
		});
		expect(response.status).toBe(404);
	}
	for (const path of ["notes%2Fnested", "notes/nested", ""]) {
		const response = await fetch(app.url + `/api/topics/${path}?depth=nope`, { headers: { cookie } });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "query_invalid", retriable: false } });
	}
});
