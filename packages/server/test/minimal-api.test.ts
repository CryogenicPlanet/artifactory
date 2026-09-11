import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("combines exact explicit mentions with a topic union, excludes self, paginates and supports newest and sequence mutations", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login(),
		other = await app.login();
	await app.ready(cookie);
	const post = async (topic: string, body: string, author = other) =>
		(await app.post("/api/messages", { topic, body }, author)).json();
	const get = async (query: string) => {
		const response = await fetch(app.url + "/api/messages?mark=0&" + query, { headers: { cookie } });
		expect(response.status, await response.clone().text()).toBe(200);
		return response.json();
	};
	const home = await post("@rahul/human/task", "home");
	await post("@rahul/human-cloud", "wrong home");
	for (const body of ["@rahulX", "@rahulé", "x@rahul", "@rahul/other", "@rahul/", "@rahul.ending"])
		await post("elsewhere", body);
	const direct = await post("elsewhere", "hello (@rahul), [@rahul/human]"),
		unicode = await post("elsewhere", "hello @alice—"),
		everyone = await post("elsewhere", "hello @here!");
	await post("@rahul/human", "@rahul @here", cookie);
	const query = "since=0&topic=@rahul/human&recursive=1&mentions=@rahul,@alice&exclude_self=1";
	expect((await get(query)).items).toEqual([home, direct, unicode]);
	expect((await get("since=0&mentions=@here&exclude_self=1")).items).toEqual([everyone]);
	const page = await get(query + "&limit=1");
	expect(page.items).toEqual([home]);
	expect(page.cursor).toBe(home.seq);
	const next = await get(query.replace("since=0", `since=${page.cursor}`) + "&limit=1");
	expect(next.items).toEqual([direct]);
	expect((await get("newest=1&limit=2&exclude_self=1")).items).toEqual([unicode, everyone]);
	const empty = await get("since=0&mentions=@nobody");
	expect(empty.items).toEqual([]);
	expect(empty.cursor).toBeGreaterThan(everyone.seq);
	const mutate = (method: string, body?: unknown) =>
		fetch(`${app.url}/api/messages/${direct.seq}`, {
			method,
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const edit = await mutate("PATCH", { body: "changed @alice" });
	expect(edit.status).toBe(200);
	expect(await edit.json()).toMatchObject({ id: direct.id, seq: direct.seq, body: "changed @alice" });
	expect((await get("since=0&mentions=@rahul&exclude_self=1")).items).toEqual([]);
	const deleted = await mutate("DELETE");
	expect(deleted.status).toBe(200);
	expect(await deleted.json()).toMatchObject({ id: direct.id, seq: direct.seq, deleted_at: expect.any(Number) });
	expect((await get("since=0&mentions=@alice")).items).toEqual([unicode]);
}, 30000);

it("marks only returned message sequences at the requested topic or root, with side-effect-free peeks and no events", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login(),
		other = await app.login();
	await app.ready(cookie);
	const post = async (topic: string, body: string) => (await app.post("/api/messages", { topic, body }, other)).json();
	const first = await post("project/child", "first"),
		second = await post("project/child", "second"),
		outside = await post("outside", "third");
	const get = async (path: string) => {
		const response = await fetch(app.url + path, { headers: { cookie } });
		expect(response.status).toBe(200);
		return response.json();
	};
	const before = await fixture.sql(
		"SELECT COUNT(*) AS count FROM outbox WHERE json_extract(event,'$.type') NOT LIKE 'ext.%'",
	);
	await get("/api/messages?since=0&topic=project&recursive=1&mark=0");
	await get("/api/topics?mark=0");
	expect(await fixture.sql("SELECT topic,seq FROM reads")).toEqual([]);
	await get("/api/messages?since=0&topic=project&recursive=1&limit=1");
	expect(await fixture.sql("SELECT topic,seq FROM reads")).toEqual([{ topic: "project", seq: first.seq }]);
	await get("/api/topics/project"); // Empty direct-message view must not mark the unseen subtree.
	expect(await fixture.sql("SELECT topic,seq FROM reads")).toEqual([{ topic: "project", seq: first.seq }]);
	await get("/api/topics/project/child");
	expect(await fixture.sql("SELECT topic,seq FROM reads ORDER BY topic")).toEqual([
		{ topic: "project", seq: first.seq },
		{ topic: "project/child", seq: second.seq },
	]);
	await get("/api/messages?newest=1&limit=1");
	expect(await fixture.sql("SELECT topic,seq FROM reads WHERE topic=''")).toEqual([{ topic: "", seq: outside.seq }]);
	const marks = await fixture.sql("SELECT * FROM reads ORDER BY topic");
	await get("/api/messages?newest=1&limit=1");
	expect(await fixture.sql("SELECT * FROM reads ORDER BY topic")).toEqual(marks);
	expect(
		await fixture.sql("SELECT COUNT(*) AS count FROM outbox WHERE json_extract(event,'$.type') NOT LIKE 'ext.%'"),
	).toEqual(before);
	expect((await get("/api/events?since=0&types=read.marked")).items).toEqual([]);
}, 30000);
