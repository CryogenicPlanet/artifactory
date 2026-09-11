import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("moves a published subtree and its pages while keeping identities, event payloads and old retry outcomes", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (url: string, path: string) => fetch(url + path, { headers: { cookie } });
	const one = async (url: string, seq: number) =>
		(await (await get(url, `/api/messages?since=${seq - 1}&limit=1`)).json()).items[0];
	const first = await (
		await app.post("/api/messages", { topic: "project/child", body: "moveable evidence" }, cookie, "first-message")
	).json();
	const sibling = await (
		await app.post("/api/messages", { topic: "project-other", body: "untouched sibling" }, cookie)
	).json();
	expect((await get(app.url, "/api/topics/project/child")).status).toBe(200);
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
	expect(await one(app.url, first.seq)).toMatchObject({
		...first,
		topic: "area/renamed/child",
	});
	expect(await one(app.url, sibling.seq)).toEqual(sibling);
	expect((await get(app.url, "/api/topics/project")).status).toBe(404);
	const detail = await (await get(app.url, "/api/topics/area/renamed/child")).json();
	expect(detail.meta).toEqual({ public: true, status: "doing" });
	expect(detail.unread).toBe(0);
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
	expect(await one(restarted.url, recreated.seq)).toEqual(recreated);
	expect(await one(restarted.url, first.seq)).toMatchObject({
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
	expect(
		await fixture.sql(
			"SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('topic_moves','topic_page_moves')",
			"boot.db",
		),
	).toEqual([]);
	expect(
		(await (await fetch(app.url + `/api/messages?since=${original.seq - 1}&limit=1`, { headers: { cookie } })).json())
			.items,
	).toEqual([original]);
}, 30000);

it("isolates pending page moves and hides ownership markers after completion", async (test) => {
	const fixture = await conversation(test);
	for (const topic of ["original", "unrelated"]) {
		await mkdir(join(fixture.root, "pages", topic), { recursive: true });
		await writeFile(join(fixture.root, "pages", topic, "file.txt"), `${topic} bytes`);
	}
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string) => fetch(app.url + path, { headers: { cookie } });
	const put = async (path: string, body: string) => {
		const send = () =>
			fetch(app.url + path, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body,
			});
		const pending = Schema.Struct({
			error: Schema.Struct({ code: Schema.Literals(["publication_pending"]), retriable: Schema.Literals([true]) }),
		});
		let response = await send();
		// Live system diagnostics can hold an app reservation briefly. Only this explicit
		// pre-journal refusal is safe to retry; uncertain writes and other errors are not retried.
		await expect
			.poll(
				async () => {
					if (response.status === 503 && Schema.is(pending)(await response.clone().json())) response = await send();
					return response.status;
				},
				{ timeout: 2000, interval: 20 },
			)
			.toBe(200);
		return response;
	};
	await fixture.sql(
		"CREATE TRIGGER reject_completion BEFORE INSERT ON outbox WHEN json_extract(NEW.event,'$.type')='topic.pages_moved' BEGIN SELECT RAISE(ABORT,'test completion failure'); END",
	);
	const failed = await app.post("/api/topics/original/move", { to: "destination" }, cookie, "pending-move");
	expect(failed.status).toBeGreaterThanOrEqual(500);
	expect(await fixture.sql("SELECT from_path,to_path,completed FROM topic_page_continuations")).toEqual([
		{ from_path: "original", to_path: "destination", completed: 0 },
	]);
	expect(await readFile(join(fixture.root, "pages/destination/file.txt"), "utf8")).toBe("original bytes");
	for (const path of ["original/file.txt", "destination/file.txt"]) {
		const page = await get(`/p/${path}`);
		expect(page.status, path).toBe(503);
		expect(await page.json()).toMatchObject({ error: { code: "pages_move_pending", retriable: true } });
		const repaired = await put(`/api/fs/pages/${path}`, "explicit raw repair");
		expect(repaired.status, `${path}: ${await repaired.clone().text()}`).toBe(200);
	}
	expect(await (await get("/p/unrelated/file.txt")).text()).toBe("unrelated bytes");
	expect((await put("/api/fs/pages/unrelated/file.txt", "still writable")).status).toBe(200);
	expect(await (await get("/p/unrelated/file.txt")).text()).toBe("still writable");
	expect((await app.post("/api/messages", { topic: "unrelated", body: "still accepts writes" }, cookie)).status).toBe(
		200,
	);
	const pendingListing = await (await get("/p/")).text();
	expect(pendingListing).toContain("unrelated/");
	expect(pendingListing).not.toContain("destination/");
	await fixture.sql("DROP TRIGGER reject_completion");
	const finished = await app.post("/api/topics/original/move", { to: "destination" }, cookie, "pending-move");
	expect(finished.status, await finished.clone().text()).toBe(200);
	expect(await fixture.sql("SELECT completed FROM topic_page_continuations")).toEqual([{ completed: 1 }]);
	expect(await (await get("/p/destination/file.txt")).text()).toBe("explicit raw repair");
	const marker = (await readdir(join(fixture.root, "pages/destination"))).find((name) =>
		name.startsWith(".comms-move-"),
	);
	if (!marker) throw Error("Expected retained move ownership marker");
	for (const path of ["/p/destination/", "/api/fs/pages/destination/"]) {
		const listing = await get(path);
		expect(listing.status).toBe(200);
		expect(await listing.text()).not.toContain(".comms-move-");
	}
	for (const path of [`/p/destination/${marker}`, `/api/fs/pages/destination/${marker}`])
		expect((await get(path)).status, path).toBe(400);
}, 30000);

it("rechecks stale anonymous grants after a public move and private source recreation", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages/original"), { recursive: true });
	await writeFile(join(fixture.root, "pages/original/file.txt"), "original public bytes");
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const grant = await fetch(app.url + "/api/topics/original", {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
		body: JSON.stringify({ meta: { public: true } }),
	});
	expect(grant.status).toBe(200);
	expect(await (await fetch(app.url + "/p/original/file.txt")).text()).toBe("original public bytes");
	expect((await app.post("/api/topics/original/move", { to: "destination" }, cookie, "public-move")).status).toBe(200);
	await mkdir(join(fixture.root, "pages/original"));
	await writeFile(join(fixture.root, "pages/original/file.txt"), "replacement private bytes");
	expect((await app.post("/api/messages", { topic: "original", body: "private replacement" }, cookie)).status).toBe(
		200,
	);
	// Simulate the stale boot grant of a request admitted immediately before the move.
	// Boot still supplies the genuine guarded header; app must recheck current SQL ownership.
	await fixture.sql("INSERT INTO public_paths(path) VALUES('original')", "boot.db");
	for (const method of ["GET", "HEAD"]) {
		const response = await fetch(app.url + "/p/original/file.txt", { method });
		expect(response.status, method).toBe(404);
		expect(await response.text()).not.toContain("replacement private bytes");
	}
	// An unpublished regrant must not supersede the pinned published private image.
	await fixture.sql(
		`UPDATE topics SET meta='{"public":true}', updated_seq=999999, previous=json_object('meta',json('{}'),'archived_at',NULL,'deleted_at',NULL) WHERE path='original'`,
	);
	const unpublished = await fetch(app.url + "/p/original/file.txt");
	expect(unpublished.status).toBe(404);
	expect(await unpublished.text()).not.toContain("replacement private bytes");
	expect(await (await fetch(app.url + "/p/destination/file.txt")).text()).toBe("original public bytes");
	expect(await (await fetch(app.url + "/p/original/file.txt", { headers: { cookie } })).text()).toBe(
		"replacement private bytes",
	);
}, 30000);
