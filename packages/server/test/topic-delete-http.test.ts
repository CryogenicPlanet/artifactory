import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("publishes one subtree deletion and replays the exact HTTP outcome after restart, including page-only topics", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const remove = (url: string, path: string, key?: string) =>
		fetch(url + "/api/topics/" + path, {
			method: "DELETE",
			headers: { cookie, origin: "https://comms.test", ...(key ? { "idempotency-key": key } : {}) },
		});
	const message = await (await app.post("/api/messages", { topic: "project/child", body: "durable" }, cookie)).json();
	await mkdir(join(fixture.root, "pages/project/child"), { recursive: true });
	await writeFile(join(fixture.root, "pages/project/child/index.md"), "# Hidden after deletion");
	expect(
		(
			await fetch(app.url + "/api/topics/project/child", {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
				body: JSON.stringify({ meta: { public: true } }),
			})
		).status,
	).toBe(200);
	expect((await fetch(app.url + "/p/project/child/index.md?raw=1")).status).toBe(200);
	const pageSource = "/api/fs/pages/project/child/index.md";
	const pageWrite = await fetch(app.url + pageSource, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: "# Published revision",
	});
	expect(pageWrite.status).toBe(200);
	const pageBatch = (await pageWrite.json()).batch;
	const pageHistory = await (await fetch(app.url + pageSource + "?history", { headers: { cookie } })).json();
	const response = await remove(app.url, "project", "delete-project");
	expect(response.status).toBe(200);
	const deleted = await response.json();
	expect(deleted).toEqual({ path: "project", deleted_at: expect.any(Number), seq: expect.any(Number) });
	expect(await (await remove(app.url, "project", "delete-project")).json()).toEqual(deleted);
	expect((await remove(app.url, "project")).status).toBe(404);
	for (const path of [
		"/api/topics/project/child",
		`/api/messages/${message.id}`,
		"/p/project/child/index.md",
		"/p/project/child/index.md?raw=1",
	])
		expect((await fetch(app.url + path, { headers: { cookie } })).status, path).toBe(404);
	expect((await fetch(app.url + "/p/project/child/index.md?raw=1")).status).toBe(401);
	expect((await app.post("/api/messages", { topic: "project/child", body: "cannot recreate" }, cookie)).status).toBe(
		404,
	);
	expect(
		(
			await fetch(app.url + "/api/fs/pages/project/child/new.md", {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: "cannot recreate",
			})
		).status,
	).toBe(409);
	// Page undo must use the same tombstone admission as ordinary page writes, even without an app lock.
	for (const selector of [
		{ path: "pages/project/child/index.md" },
		{ batch: pageBatch },
		{ version: pageHistory.items[0].id },
	]) {
		const undone = await app.post("/api/revert", selector, cookie);
		expect(undone.status).toBe(409);
		expect(await undone.json()).toMatchObject({ error: { code: "topic_deleted" } });
	}
	expect(await (await fetch(app.url + pageSource, { headers: { cookie } })).text()).toBe("# Published revision");
	expect(await fixture.sql("SELECT * FROM edit_lock", "boot.db")).toEqual([]);
	expect(await fixture.sql("SELECT * FROM source_changes", "boot.db")).toEqual([]);
	expect(
		(
			await fetch(app.url + "/api/fs/pages/available.md", {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: "proposal was released",
			})
		).status,
	).toBe(200);
	expect((await remove(app.url, "missing")).status).toBe(404);
	expect((await remove(app.url, "project?bad=1")).status).toBe(400);
	expect((await remove(app.url, "bad%2F..%2Fpath")).status).toBe(400);
	await mkdir(join(fixture.root, "pages/page-only/child"), { recursive: true });
	await writeFile(join(fixture.root, "pages/page-only/child/index.md"), "# Retained page");
	expect((await fetch(app.url + "/p/page-only/child/index.md?raw=1", { headers: { cookie } })).status).toBe(200);
	const pageResponse = await remove(app.url, "page-only", "delete-page");
	expect(pageResponse.status).toBe(200);
	const pageDeleted = await pageResponse.json();
	expect((await fetch(app.url + "/p/page-only/child/index.md?raw=1", { headers: { cookie } })).status).toBe(404);
	expect(await fixture.sql("SELECT path FROM topics WHERE deleted_at IS NOT NULL ORDER BY path")).toEqual([
		{ path: "page-only" },
		{ path: "project" },
	]);
	expect(await fixture.sql("SELECT id FROM messages")).toEqual([{ id: message.id }]);
	const events = await (
		await fetch(app.url + "/api/events?since=0&types=topic.deleted", { headers: { cookie } })
	).json();
	expect(events.items.map((item: { payload: unknown }) => item.payload)).toEqual([deleted, pageDeleted]);
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(await (await remove(resumed.url, "project", "delete-project")).json()).toEqual(deleted);
	expect(await (await remove(resumed.url, "page-only", "delete-page")).json()).toEqual(pageDeleted);
}, 30000);
