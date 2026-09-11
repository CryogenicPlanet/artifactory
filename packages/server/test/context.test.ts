import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("composes private README, published priorities, subtopics and caller-specific unread without marking read", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const first = await app.login(),
		second = await app.login();
	await app.ready(first);
	await mkdir(join(fixture.root, "pages/project"), { recursive: true });
	await writeFile(join(fixture.root, "pages/project/index.md"), "Read this project context first.");
	await writeFile(join(fixture.root, "pages/project/plan.md"), "A linked plan.");
	const pinned = await (
		await app.post(
			"/api/messages",
			{ topic: "project", body: "Pinned project decision", meta: { pinned: true } },
			first,
		)
	).json();
	const deleted = await (
		await app.post("/api/messages", { topic: "project", body: "Tombstoned secret" }, first)
	).json();
	const question = await (
		await app.post("/api/messages", { topic: "project/task", body: "Unresolved question", tags: ["question"] }, second)
	).json();
	await app.post("/api/messages", { topic: "other", body: "Inbox-only mention @rahul" }, second);
	const deletedChild = await (
		await app.post("/api/messages", { topic: "project/task", body: "Removed child latest" }, first)
	).json();
	expect(
		(
			await fetch(`${app.url}/api/messages/${deletedChild.id}`, {
				method: "DELETE",
				headers: { cookie: first, origin: "https://comms.test" },
			})
		).status,
	).toBe(200);
	expect(
		(
			await fetch(`${app.url}/api/messages/${deleted.id}`, {
				method: "DELETE",
				headers: { cookie: first, origin: "https://comms.test" },
			})
		).status,
	).toBe(200);
	expect((await app.post("/api/read", { topic: "project", seq: question.seq }, first)).status).toBe(200);
	const read = (cookie: string, query = "topic=project&budget=4000") =>
		fetch(`${app.url}/api/ctx?${query}`, { headers: { cookie } });
	const response = await read(first),
		text = await response.text();
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(text.indexOf("Read this project context first.")).toBeLessThan(text.indexOf("Pinned project decision"));
	expect(text).toContain("Unread in topic tree: 0.");
	expect(text).toContain("Inbox-only mention @rahul");
	expect(text).toContain(`last #${question.seq}: Unresolved question`);
	expect(text).not.toContain(`last #${deletedChild.seq}: Unresolved question`);
	expect(text).toContain("/p/project/plan.md");
	expect(text).not.toContain("Tombstoned secret");
	expect(text).toContain("Truncated: no.");
	expect(await (await read(second)).text()).toContain("Unread in topic tree: 2.");
	expect(await (await read(second)).text()).not.toContain("Inbox-only mention @rahul");
	expect(await (await read(first, `topic=project&since=${question.seq}`)).text()).toContain(`## #${pinned.seq}`);
	const marks = await fixture.sql("SELECT instance,topic,seq FROM reads ORDER BY instance,topic");
	await read(first);
	expect(await fixture.sql("SELECT instance,topic,seq FROM reads ORDER BY instance,topic")).toEqual(marks);
	expect(
		(
			await fetch(`${app.url}/api/ctx?topic=project`, {
				headers: { "x-comms-agent": "rahul", "x-comms-scopes": "read" },
			})
		).status,
	).toBe(401);
	for (const query of [
		"budget=99",
		"budget=16001",
		"budget=",
		"since=-1",
		"since=9007199254740991",
		"topic=../private",
		"extra=1",
	])
		expect((await read(first, query)).status).toBe(400);
}, 20000);

it("caps long README and message output, flags omissions and reads page-only topics", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await mkdir(join(fixture.root, "pages/notes"), { recursive: true });
	await writeFile(join(fixture.root, "pages/notes/index.md"), "Useful README " + "📓".repeat(12000));
	const read = (budget: number) => fetch(`${app.url}/api/ctx?topic=notes&budget=${budget}`, { headers: { cookie } });
	expect(await (await read(4000)).text()).toContain("Useful README");
	await app.post(
		"/api/messages",
		{ topic: "notes", body: "Important blocked work " + "x".repeat(8000), tags: ["blocked"] },
		cookie,
	);
	for (const budget of [100, 200, 4000]) {
		const response = await read(budget),
			text = await response.text();
		expect(response.status).toBe(200);
		expect(text.length).toBeLessThanOrEqual(budget * 4);
		expect(text).toContain("Truncated: yes.");
		expect(text).toContain("Approximate budget:");
	}
}, 20000);

it("bounds inbox history scanned by the digest without changing ordinary inbox results", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await app.post("/api/messages", { topic: "project", body: "Standing context" }, cookie);
	// Preseed a published history to exercise read complexity without thousands of HTTP writes.
	await fixture.sql(
		"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2001) INSERT INTO messages(id,seq,topic,agent,instance,body,tags,meta,created_at) SELECT 'seed_'||x,100000+x,'history','other','other',CASE WHEN x=2001 THEN 'Late inbox mention @rahul' ELSE 'Unrelated historic message' END,'[]','{}',0 FROM n",
	);
	await fixture.sql("UPDATE seq SET next=102002,published_through=102001", "boot.db");
	const response = await fetch(`${app.url}/api/ctx?topic=project`, { headers: { cookie } });
	expect(response.status).toBe(200);
	const text = await response.text();
	expect(text).toContain("Inbox (agent mode): 0+.");
	expect(text).toContain("Truncated: yes.");
	expect(text).not.toContain("Late inbox mention");
	const inbox = await (await fetch(`${app.url}/api/inbox?since=0`, { headers: { cookie } })).json();
	expect(inbox.items).toHaveLength(1);
	expect(inbox.items[0].body).toBe("Late inbox mention @rahul");
	expect(inbox).not.toHaveProperty("scan_truncated");
}, 20000);

it("includes bounded published activity for the subtree and shared failures without event payloads or private requests", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await app.post("/api/messages", { topic: "project", body: "Standing context" }, cookie);
	const rows = Array.from({ length: 25 }, (_, index) => ({
		seq: 100001 + index,
		at: 0,
		type: "message.edited",
		level: "info",
		actor: "other",
		instance: "other",
		generation: 1,
		request_id: null,
		topic: index === 0 ? "project-other" : "project/task",
		message_id: "historic",
		payload: { body: "Deleted historic payload must stay hidden", token: "never-render-token" },
	}));
	const events = [
		...rows,
		...["generation.failed", "ext.error", "http.request"].map((type, index) => ({
			seq: 100026 + index,
			at: 0,
			type,
			level: "error",
			actor: "other",
			instance: "other",
			generation: 2,
			request_id: "private-request",
			topic: null,
			message_id: null,
			payload: { error: "never-render-token" },
		})),
	];
	// Seed deterministic retained log records; all stores and credentials belong to this fixture.
	await fixture.sql(
		`INSERT INTO events(seq,transaction_id,event) VALUES ${events.map((event) => `(${event.seq},NULL,'${JSON.stringify(event)}')`).join(",")}`,
		"boot.db",
	);
	await fixture.sql("UPDATE seq SET next=100029,published_through=100028", "boot.db");
	const before = await fixture.sql("SELECT instance,topic,seq FROM reads ORDER BY instance,topic");
	const read = (budget: number, since = 100000) =>
		fetch(`${app.url}/api/ctx?topic=project&since=${since}&budget=${budget}`, { headers: { cookie } });
	const response = await read(16000),
		text = await response.text();
	expect(response.status).toBe(200);
	expect(text).toContain("#100002 · message.edited");
	expect(text).not.toContain("#100001 ·");
	expect(text).not.toContain("#100022 ·");
	expect(text).toContain("#100026 · generation.failed");
	expect(text).toContain("#100027 · ext.error");
	expect(text).not.toContain("http.request");
	expect(text).not.toContain("never-render-token");
	expect(text).not.toContain("Deleted historic payload");
	expect(text).toContain("since=100021");
	expect(text).toContain("Truncated: yes.");
	expect(text).toContain("separate log reads");
	const later = await (await read(16000, 100026)).text();
	expect(later).not.toContain("#100026 · generation.failed");
	expect(later).toContain("#100027 · ext.error");
	for (const budget of [100, 200, 4000]) {
		const bounded = await (await read(budget)).text();
		expect(bounded.length).toBeLessThanOrEqual(budget * 4);
		expect(bounded).toContain("Truncated: yes.");
	}
	expect(await fixture.sql("SELECT instance,topic,seq FROM reads ORDER BY instance,topic")).toEqual(before);
}, 20000);
