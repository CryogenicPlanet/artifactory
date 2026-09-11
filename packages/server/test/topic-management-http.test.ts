import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("upserts topic metadata and archives subtrees through authenticated, replayable published writes", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const call = (method: string, path: string, body?: unknown, key?: string, credential = cookie) =>
		fetch(app.url + path, {
			method,
			headers: {
				cookie: credential,
				origin: "https://comms.test",
				"content-type": "application/json",
				...(key ? { "idempotency-key": key } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const get = async (path: string) => (await call("GET", path)).json();
	const path = "/api/topics/project/notes";
	await mkdir(join(fixture.root, "pages/project/notes"), { recursive: true });
	await writeFile(join(fixture.root, "pages/project/notes/index.md"), "# Public notes");
	expect((await fetch(app.url + "/p/project/notes/")).status).toBe(401);
	const first = await (await call("PUT", path, { meta: { public: true, status: "doing" } }, "upsert")).json();
	expect(first).toMatchObject({
		path: "project/notes",
		meta: { public: true, status: "doing" },
		archived_at: null,
		seq: expect.any(Number),
	});
	expect(await get(path)).toMatchObject({ meta: first.meta, messages: [], archived_at: null, archived_by: null });
	expect((await fetch(app.url + "/p/project/notes/")).status).toBe(200);
	expect((await get("/api/topics")).subtopics).toEqual([expect.objectContaining({ path: "project" })]);
	const replaced = await (await call("PUT", path, { meta: { owner: "codex" } })).json();
	expect(replaced.meta).toEqual({ owner: "codex" });
	expect((await fetch(app.url + "/p/project/notes/")).status).toBe(401);
	expect(await (await call("PUT", path, { meta: first.meta }, "upsert")).json()).toEqual(first);
	expect((await get(path)).meta).toEqual({ owner: "codex" });
	expect((await call("PUT", path, { meta: {} }, "upsert")).status).toBe(409);
	const message = await (
		await app.post("/api/messages", { topic: "project/notes/child", body: "retained" }, cookie)
	).json();
	await app.post("/api/messages", { topic: "project-other", body: "unrelated" }, cookie);
	const archived = await (await call("PATCH", "/api/topics/project", { archived: true }, "archive")).json();
	expect(archived.archived_at).toEqual(expect.any(Number));
	expect((await get("/api/topics")).subtopics.map((row: { path: string }) => row.path)).toEqual(["project-other"]);
	expect((await get("/api/topics")).unread).toBe(1);
	expect((await get("/api/topics?archived=1")).subtopics).toHaveLength(2);
	expect(await get("/api/topics/project")).toMatchObject({ archived_at: archived.archived_at, archived_by: "project" });
	expect(await get("/api/topics/project/notes/child")).toMatchObject({
		messages: [message],
		archived_at: null,
		archived_by: "project",
	});
	for (const [method, target, body] of [
		["PUT", path, { meta: {} }],
		["PUT", "/api/topics/project/new", { meta: {} }],
		["PATCH", path, { archived: false }],
	] satisfies Array<[string, string, unknown]>)
		expect((await call(method, target, body)).status).toBe(409);
	expect((await app.post("/api/messages", { topic: "project/notes/child", body: "denied" }, cookie)).status).toBe(409);
	expect((await call("PATCH", "/api/topics/project", { archived: false })).status).toBe(200);
	expect(await (await call("PATCH", "/api/topics/project", { archived: true }, "archive")).json()).toEqual(archived);
	expect((await get("/api/topics")).unread).toBe(2);
	expect(await get("/api/topics/project/notes/child")).toMatchObject({ archived_at: null, archived_by: null });
	for (const [method, target, body] of [
		["PUT", path, {}],
		["PUT", path, { meta: {}, ignored: 1 }],
		["PATCH", path, { archived: "true" }],
		["PATCH", path, { archived: false, meta: {} }],
		["PUT", "/api/topics/bad%2F..%2Fpath", { meta: {} }],
		["PUT", path + "?unknown=1", { meta: {} }],
	] satisfies Array<[string, string, unknown]>)
		expect((await call(method, target, body)).status).toBe(400);
	expect((await call("PATCH", "/api/topics/missing", { archived: true })).status).toBe(404);
	expect((await call("PUT", path, { meta: {} }, undefined, "")).status).toBe(401);
	const enrollment = await (await app.post("/auth/enroll", { name: "reader", kind: "codex", host: "test" })).json();
	const params = { id: enrollment.id, decision: "approve" as const, scopes: ["read"], long_lived: false };
	const proof = await app.assertion(params);
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", "x-comms-assertion": proof },
				body: JSON.stringify({ decision: params.decision, scopes: params.scopes, long_lived: params.long_lived }),
			})
		).status,
	).toBe(200);
	const access = (
		await (await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })).json()
	).access;
	expect(
		(
			await fetch(app.url + path, {
				method: "PUT",
				headers: {
					authorization: `Bearer ${access}`,
					"content-type": "application/json",
					"x-comms-scopes": "read,write",
				},
				body: JSON.stringify({ meta: {} }),
			})
		).status,
	).toBe(403);
	const events = await get("/api/events?since=0&types=topic.*&topic=project");
	expect(events.items.filter((event: { type: string }) => event.type === "topic.meta")).toHaveLength(2);
	expect(events.items.filter((event: { type: string }) => event.type === "topic.archived")).toHaveLength(2);
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM outbox WHERE shipped_at IS NULL")).toEqual([{ count: 0 }]);
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect((await (await fetch(resumed.url + path, { headers: { cookie } })).json()).meta).toEqual({ owner: "codex" });
}, 30000);
