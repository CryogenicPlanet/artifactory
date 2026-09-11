import { rm, access } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("persists two signed-in instances, implicit topics, published events, idempotency, waits and a markdown digest", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const first = await app.login(),
		second = await app.login();
	await app.ready(first);
	const input = { topic: "project/auth/thread", body: "First question", tags: ["question"], meta: { pinned: true } };
	const posted = await app.post("/api/messages", input, first, "same-request");
	expect(posted.status).toBe(200);
	const message = await posted.json();
	expect(message).toMatchObject({ ...input, agent: "rahul" });
	const duplicate = await app.post("/api/messages", input, first, "same-request");
	expect(duplicate.status).toBe(200);
	expect(await duplicate.json()).toEqual(message);
	expect((await app.post("/api/messages", { ...input, body: "different" }, first, "same-request")).status).toBe(409);
	const read = async (path: string, cookie = first) => fetch(`${app.url}${path}`, { headers: { cookie } });
	expect((await fetch(`${app.url}/api/messages`)).status).toBe(401);
	expect(await (await read("/api/messages?since=0&topic=project&recursive=1")).json()).toMatchObject({
		items: [message],
		cursor: message.seq,
	});
	const now = await (await read("/api/messages")).json();
	expect(now).toEqual({ items: [], cursor: expect.any(Number), timed_out: false, drained: false });
	expect(now.cursor).toBeGreaterThanOrEqual(message.seq);
	const events = await (await read("/api/events?since=0&topic=project")).json();
	expect(events.items.map((event: { type: string }) => event.type)).toEqual([
		"topic.created",
		"topic.created",
		"topic.created",
		"message.created",
	]);
	expect(events.items.at(-1).payload).toEqual(message);
	const wait = read(`/api/messages?topic=project/auth/thread&since=${message.seq}&wait=5`);
	const own = await app.post("/api/messages", { ...input, body: "Own message" }, first);
	expect(own.status).toBe(200);
	const reply = await app.post("/api/messages", { ...input, body: "Second instance reply" }, second);
	const answer = await reply.json();
	expect(answer.instance).not.toBe(message.instance);
	const received = await (await wait).json();
	expect(received.items).toEqual([answer]);
	expect(received.cursor).toBe(answer.seq);
	expect(await (await read("/api/messages?since=0&topic=project/auth&t=bad")).json()).toMatchObject({
		error: { code: "query_invalid" },
	});
	const digest = await read("/api/ctx?topic=project&budget=200");
	expect(digest.headers.get("content-type")).toContain("text/markdown");
	expect(await digest.text()).toContain("First question");
	expect((await (await read("/api")).json()).paths["/api/messages"].post.description).toContain(
		"durable event publication",
	);
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM topics")).toEqual([{ count: 3 }]);
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM outbox WHERE shipped_at IS NULL")).toEqual([{ count: 0 }]);
	await app.stop();
	const resumed = await fixture.launch();
	const again = await resumed.login();
	await resumed.ready(again);
	const history = await (await fetch(`${resumed.url}/api/messages?since=0`, { headers: { cookie: again } })).json();
	expect(history.items).toHaveLength(3);
	expect(history.items[0]).toEqual(message);
}, 30000);

it("keeps subtree boundaries and limit cursors safe and empty waits preserve since", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	for (const topic of ["@pi", "@pi-cloud", "@pi/child"])
		expect((await app.post("/api/messages", { topic, body: topic }, cookie)).status).toBe(200);
	const read = async (path: string) => (await fetch(`${app.url}${path}`, { headers: { cookie } })).json();
	const page = await read("/api/messages?topic=@pi&recursive=1&since=0&limit=1");
	expect(page.items[0].topic).toBe("@pi");
	expect(page.cursor).toBe(page.items[0].seq);
	const next = await read(`/api/messages?topic=@pi&recursive=1&since=${page.cursor}&limit=1`);
	expect(next.items[0].topic).toBe("@pi/child");
	expect(await read("/api/messages?since=0&wait=1")).toEqual({ items: [], cursor: 0, timed_out: true, drained: false });
	expect(await read("/api/events?topic=@pi&since=0&types=message.*")).toMatchObject({
		items: [{ topic: "@pi" }, { topic: "@pi/child" }],
	});
}, 20000);

it("keeps authentication and recovery help after the initialized app store disappears", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await app.stop();
	await rm(join(fixture.root, "comms.db"));
	const next = await fixture.launch();
	const relogged = await next.login();
	expect((await fetch(`${next.url}/_boot`, { headers: { cookie: relogged } })).status).toBe(200);
	await expect
		.poll(async () => {
			const response = await fetch(`${next.url}/_boot/status`, { headers: { cookie: relogged } });
			return (await response.json()).child.error;
		})
		.toContain("app_store_missing");
	expect((await fetch(`${next.url}/api/messages`, { headers: { cookie: relogged } })).status).toBe(503);
	await expect(access(join(fixture.root, "comms.db"))).rejects.toThrow();
}, 12000);
