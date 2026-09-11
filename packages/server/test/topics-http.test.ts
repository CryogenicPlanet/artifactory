import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("lists real topic ancestry and latest messages, with instance-scoped monotonic marks and archived rollups", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const first = await app.login(),
		second = await app.login();
	await app.ready(first);
	const read = async (path: string, cookie = first) => (await fetch(app.url + path, { headers: { cookie } })).json();
	const post = async (topic: string, body: string) => {
		const response = await app.post("/api/messages", { topic, body }, first);
		expect(response.status).toBe(200);
		return response.json();
	};
	const a = await post("project/one", "one"),
		b = await post("project/two/deep", "two"),
		c = await post("project-other", "unrelated");
	expect(await read("/api/topics")).toMatchObject({
		path: "",
		unread: 3,
		messages: [a, b, c],
		subtopics: [
			{ path: "project-other", unread: 1 },
			{ path: "project", unread: 2 },
		],
	});
	expect(await read("/api/topics/project")).toMatchObject({
		unread: 2,
		messages: [],
		subtopics: [
			{ path: "project/two", unread: 1 },
			{ path: "project/one", unread: 1 },
		],
	});
	expect((await read("/api/topics/project?depth=2")).subtopics).toHaveLength(3);
	expect(await (await app.post("/api/read", { topic: "project", seq: b.seq }, first, "mark-parent")).json()).toEqual({
		topic: "project",
		seq: b.seq,
	});
	expect(await (await app.post("/api/read", { topic: "project/one", seq: a.seq }, first, "mark-child")).json()).toEqual(
		{ topic: "project/one", seq: b.seq },
	);
	expect(await fixture.sql("SELECT topic,seq FROM reads ORDER BY topic")).toEqual([
		{ topic: "project", seq: b.seq },
		{ topic: "project/one", seq: a.seq },
	]);
	expect((await read("/api/topics/project")).unread).toBe(0);
	expect((await read("/api/topics/project", second)).unread).toBe(2);
	const eventCount = await fixture.sql("SELECT COUNT(*) AS count FROM outbox");
	expect(await (await app.post("/api/read", { topic: "project", seq: 0 }, first)).json()).toEqual({
		topic: "project",
		seq: b.seq,
	});
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM outbox")).toEqual(eventCount);
	expect((await app.post("/api/read", { topic: "project", seq: c.seq }, first, "mark-parent")).status).toBe(409);
	await app.post("/api/read", { topic: "*", seq: c.seq }, first);
	expect((await read("/api/topics")).unread).toBe(0);
	expect(await (await app.post("/api/read", { topic: "project", seq: b.seq }, first, "mark-parent")).json()).toEqual({
		topic: "project",
		seq: b.seq,
	});
	const events = await read("/api/events?since=0&types=read.marked");
	expect(events.items).toHaveLength(3);
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM outbox WHERE shipped_at IS NULL")).toEqual([{ count: 0 }]);
	await fixture.sql("UPDATE topics SET archived_at=1 WHERE path='project/two'");
	expect((await read("/api/topics/project", second)).unread).toBe(1);
	expect((await read("/api/topics", second)).messages).toEqual([a, c]);
	expect((await read("/api/topics/project/two", second)).subtopics).toEqual([]);
	expect((await read("/api/topics/project/two?archived=1", second)).subtopics).toHaveLength(1);
	expect((await read("/api/topics/project", second)).subtopics.map((row: { path: string }) => row.path)).toEqual([
		"project/one",
	]);
	expect((await read("/api/topics/project?archived=1", second)).subtopics).toHaveLength(2);
	expect((await fetch(app.url + "/api/topics/missing", { headers: { cookie: first } })).status).toBe(404);
	for (const query of ["?depth=0", "?depth=bad", "?archived=yes", "?unknown=1"])
		expect((await fetch(app.url + "/api/topics" + query, { headers: { cookie: first } })).status).toBe(400);
	await fixture.sql("UPDATE kernel_writer SET epoch='replaced'");
	expect((await app.post("/api/read", { topic: "~inbox", seq: c.seq }, first)).status).toBe(503);
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM reads WHERE topic='~inbox'")).toEqual([{ count: 0 }]);
}, 30000);

it("derives inbox by exact mention/home boundaries, excludes own instance, paginates matches and keeps wait separate from cursors", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const first = await app.login(),
		second = await app.login();
	await app.ready(first);
	const post = async (topic: string, body: string, cookie = second) => {
		const response = await app.post("/api/messages", { topic, body }, cookie);
		expect(response.status).toBe(200);
		return response.json();
	};
	const read = async (query = "") =>
		(await fetch(app.url + "/api/inbox" + query, { headers: { cookie: first } })).json();
	await post("@rahul", "self", first);
	const home = await post("@rahul/notes", "home");
	await post("@rahul-cloud", "not home");
	for (const body of [
		"@rahulX",
		"@rahulé",
		"x@rahul",
		"@rahul-cloud",
		"@rahul/another",
		"@rahul/",
		"@rahul.ending",
		"@rahul/../bad",
	])
		await post("other", body);
	const mention = await post("other", "hello (@rahul), [@rahul/human] @here!");
	expect((await read("?since=0&limit=1")).items).toEqual([home]);
	expect((await read(`?since=${home.seq}&limit=1`)).items).toEqual([mention]);
	expect((await read()).items).toEqual([home, mention]);
	await app.post("/api/read", { topic: "~inbox", seq: mention.seq }, first);
	expect((await read()).items).toEqual([]);
	expect((await read("?since=0")).items).toEqual([home, mention]);
	const waiting = read("?wait=5");
	await post("@rahul", "another self", first);
	const reply = await post("@rahul", "reply");
	expect((await waiting).items).toEqual([reply]);
	expect(await read(`?since=${reply.seq}&wait=1`)).toEqual({
		items: [],
		cursor: reply.seq,
		timed_out: true,
		drained: false,
	});
}, 30000);

it("migrates schema v1 preserving existing conversation and idempotency records", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const input = { topic: "preserved/thread", body: "existing" };
	const existing = await (await app.post("/api/messages", input, cookie, "existing-key")).json();
	await app.stop();
	for (const statement of [
		"DROP TRIGGER messages_fts_insert",
		"DROP TRIGGER messages_fts_update",
		"DROP TRIGGER messages_fts_delete",
		"DROP TABLE messages_fts",
		"DROP TABLE agents",
		"DROP TABLE kv",
		"DROP TABLE reactions",
		"DROP TABLE reaction_idempotency",
		"ALTER TABLE topics DROP COLUMN archived_at",
		"ALTER TABLE topics DROP COLUMN deleted_at",
		"ALTER TABLE topics DROP COLUMN updated_seq",
		"ALTER TABLE topics DROP COLUMN previous",
		"DROP TABLE topic_idempotency",
		"ALTER TABLE messages DROP COLUMN edited_at",
		"ALTER TABLE messages DROP COLUMN deleted_at",
		"ALTER TABLE messages DROP COLUMN updated_seq",
		"ALTER TABLE messages DROP COLUMN previous",
		"ALTER TABLE idempotency DROP COLUMN outcome",
		"DROP TABLE reads",
		"DROP TABLE read_idempotency",
		"PRAGMA user_version=1",
	])
		await fixture.sql(statement);
	expect(await fixture.sql("PRAGMA user_version")).toEqual([{ user_version: 1 }]);
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	const root = await (await fetch(resumed.url + "/api/topics", { headers: { cookie } })).json();
	expect(root.messages).toEqual([existing]);
	expect(await (await resumed.post("/api/messages", input, cookie, "existing-key")).json()).toEqual(existing);
	expect(await fixture.sql("PRAGMA user_version")).toEqual([{ user_version: 6 }]);
	expect(await fixture.sql("SELECT archived_at FROM topics")).toEqual([{ archived_at: null }, { archived_at: null }]);
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
	const root = await (await fetch(app.url + "/api/topics", { headers: { cookie } })).json();
	expect(root.messages).toHaveLength(100);
	expect(root.messages[0].body).toBe("message 105");
	expect(root.messages.at(-1).body).toBe("message 204");
	const topic = await (await fetch(app.url + "/api/topics/many", { headers: { cookie } })).json();
	expect(topic.subtopics).toHaveLength(205);
	expect(topic.unread).toBe(205);
	expect(topic.subtopics[0].path).toBe("many/child-204");
}, 30000);

it("lets an instance choose agent-wide home messages or only its own notifications using one shared cursor", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const first = await app.login(),
		second = await app.login();
	await app.ready(first);
	const post = async (topic: string, body: string, cookie = second) => {
		const response = await app.post("/api/messages", { topic, body }, cookie);
		expect(response.status).toBe(200);
		return response.json();
	};
	const read = async (query: string) =>
		(await fetch(app.url + "/api/inbox" + query, { headers: { cookie: first } })).json();
	const home = await post("@rahul", "agent home");
	const other = await post("@rahul/other/task", "another label");
	const ownTopic = await post("@rahul/human/task", "this label");
	const agentMention = await post("general", "hello @rahul!");
	const instanceMention = await post("general", "hello @rahul/human!");
	const everyone = await post("general", "hello @here!");
	await post("general", "hello @rahul/other!");
	await post("@rahul/human-cloud", "similar label");
	await post("@rahul/human", "@here @rahul/human", first);
	const agentItems = (await read("?mode=agent&since=0")).items;
	expect(agentItems.slice(0, 6)).toEqual([home, other, ownTopic, agentMention, instanceMention, everyone]);
	expect(agentItems).toHaveLength(7);
	expect((await read("?since=0")).items).toEqual(agentItems);
	expect((await read("?mode=instance&since=0")).items).toEqual([ownTopic, instanceMention, everyone]);
	await app.post("/api/read", { topic: "~inbox", seq: everyone.seq }, first);
	expect((await read("?mode=instance")).items).toEqual([]);
	expect((await read("?mode=agent")).items).toHaveLength(1);
	expect((await read("?mode=instance&since=0")).items).toEqual([ownTopic, instanceMention, everyone]);
	for (const mode of ["", "unknown"])
		expect((await fetch(app.url + "/api/inbox?mode=" + mode, { headers: { cookie: first } })).status).toBe(400);
}, 15000);
