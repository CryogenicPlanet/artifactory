import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("moves a published subtree and its pages while keeping identities, event payloads and old retry outcomes", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (url: string, path: string) => fetch(url + path, { headers: { cookie } });
	const first = await (
		await app.post("/api/messages", { topic: "project/child", body: "moveable evidence" }, cookie, "first-message")
	).json();
	const sibling = await (
		await app.post("/api/messages", { topic: "project-other", body: "untouched sibling" }, cookie)
	).json();
	expect((await app.post("/api/reactions", { message: first.id, emoji: "👍" }, cookie)).status).toBe(200);
	expect((await app.post("/api/read", { topic: "project/child", seq: first.seq }, cookie)).status).toBe(200);
	await mkdir(join(fixture.root, "pages/project/child/empty"), { recursive: true });
	await writeFile(join(fixture.root, "pages/project/child/index.md"), "# Moved page");
	expect(
		(
			await fetch(app.url + "/api/topics/project/child", {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
				body: JSON.stringify({ meta: { public: true, status: "doing" } }),
			})
		).status,
	).toBe(200);
	const response = await app.post("/api/topics/project/move", { to: "area/renamed" }, cookie, "move-one");
	expect(response.status, await response.clone().text()).toBe(200);
	const moved = await response.json();
	expect(await (await get(app.url, `/api/messages/${first.id}`)).json()).toMatchObject({
		...first,
		topic: "area/renamed/child",
	});
	expect(await (await get(app.url, `/api/messages/${sibling.id}`)).json()).toEqual(sibling);
	expect((await get(app.url, "/api/topics/project")).status).toBe(404);
	const detail = await (await get(app.url, "/api/topics/area/renamed/child")).json();
	expect(detail.meta).toEqual({ public: true, status: "doing" });
	expect(detail.unread).toBe(0);
	expect((await (await get(app.url, `/api/reactions?message=${first.id}`)).json()).items).toHaveLength(1);
	expect(await (await fetch(app.url + "/p/area/renamed/child/index.md?raw=1")).text()).toBe("# Moved page");
	expect((await get(app.url, "/p/project/child/index.md?raw=1")).status).toBe(404);
	expect((await stat(join(fixture.root, "pages/area/renamed/child/empty"))).isDirectory()).toBe(true);
	const events = await (await get(app.url, "/api/events?since=0&topic=area/renamed&types=message.created")).json();
	expect(events.items).toHaveLength(1);
	expect(events.items[0]).toMatchObject({ topic: "area/renamed/child", payload: first });
	expect((await (await get(app.url, "/api/events?since=0&topic=project&types=message.created")).json()).items).toEqual(
		[],
	);
	expect(await (await app.post("/api/topics/project/move", { to: "area/renamed" }, cookie, "move-one")).json()).toEqual(
		moved,
	);
	const recreated = await (
		await app.post("/api/messages", { topic: "project", body: "new source identity" }, cookie)
	).json();
	expect((await app.post("/api/topics/area/renamed/move", { to: "final" }, cookie, "move-two")).status).toBe(200);
	await app.stop();
	const restarted = await fixture.launch();
	await restarted.ready(cookie);
	expect(
		await (await restarted.post("/api/topics/project/move", { to: "area/renamed" }, cookie, "move-one")).json(),
	).toEqual(moved);
	expect(await (await get(restarted.url, `/api/messages/${recreated.id}`)).json()).toEqual(recreated);
	expect(await (await get(restarted.url, `/api/messages/${first.id}`)).json()).toMatchObject({
		id: first.id,
		seq: first.seq,
		topic: "final/child",
	});
	expect(await readFile(join(fixture.root, "pages/final/child/index.md"), "utf8")).toBe("# Moved page");
	const historical = await (await get(restarted.url, "/api/events?since=0&topic=final&types=message.created")).json();
	expect(historical.items[0]).toMatchObject({ topic: "final/child", payload: first });
}, 45000);

it("denies unauthenticated and read-only moves without changing a topic named move", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const original = await (await app.post("/api/messages", { topic: "project/move", body: "kept" }, cookie)).json();
	expect((await fetch(app.url + "/api/topics/project/move", { headers: { cookie } })).status).toBe(200);
	expect((await app.post("/api/topics/project/move", { to: "elsewhere" })).status).toBe(401);
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
			await fetch(app.url + "/api/topics/project/move", {
				method: "POST",
				headers: {
					authorization: `Bearer ${access}`,
					"content-type": "application/json",
					"x-comms-scopes": "read,write",
				},
				body: JSON.stringify({ to: "elsewhere" }),
			})
		).status,
	).toBe(403);
	expect(await fixture.sql("SELECT id FROM topic_moves", "boot.db")).toEqual([]);
	expect(await (await fetch(app.url + `/api/messages/${original.id}`, { headers: { cookie } })).json()).toEqual(
		original,
	);
}, 30000);
