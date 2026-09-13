import { sourcePut } from "./fixtures/source-put.ts";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

async function tail(
	test: TestContext,
	url: string,
	headers: Record<string, string>,
	contentType = "text/event-stream",
) {
	const controller = new AbortController();
	const response = await fetch(url, { headers, signal: controller.signal });
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain(contentType);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing stream");
	let text = "",
		closed = false;
	const finished = (async () => {
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				text += new TextDecoder().decode(part.value);
			}
		} catch {
			/* A replaced child may close the transport without a final frame. */
		} finally {
			closed = true;
		}
	})();
	const stop = async () => {
		controller.abort();
		await finished;
	};
	test.onTestFinished(stop);
	return { text: () => text, closed: () => closed, stop };
}
async function token(
	fixture: Awaited<ReturnType<typeof conversation>>,
	id: string,
	duration: number,
	scopes = '["read"]',
) {
	const value = randomBytes(32).toString("base64url");
	const hash = createHash("sha256").update(value).digest("hex");
	await fixture.sql(
		`INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at) VALUES('${id}','pair-${id}','family-${id}','codex','access','${hash}','test','${scopes}',CAST(unixepoch('subsec')*1000 AS INTEGER)+${duration},1)`,
		"boot.db",
	);
	return { authorization: `Bearer ${value}` };
}

it("app SSE resumes and filters at the boot publication boundary without exposing request diagnostics to editable streams", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie).catch(async () => {
		throw new Error(JSON.stringify(await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()));
	});
	const credentials = await token(fixture, "reader", 60000);
	const first = await (await app.post("/api/messages", { topic: "stream", body: "before resume" }, cookie)).json();
	const docs = await (await fetch(`${app.url}/api`, { headers: { cookie } })).json();
	expect(docs.paths["/api/stream"].get).toBeDefined();
	expect((await fetch(`${app.url}/api/stream`)).status).toBe(401);
	for (const query of [
		"wait=1",
		"types=bad**",
		"topic=bad%2F%2Fpath",
		"level=fatal",
		"since=1&since=2",
		"request_actor=rahul",
		"since=999999999999",
	])
		expect((await fetch(`${app.url}/api/stream?${query}`, { headers: credentials })).status, query).toBe(400);
	const messages = await tail(test, `${app.url}/api/stream?since=${first.seq}&topic=stream&types=message.*&limit=1`, {
		...credentials,
		"last-event-id": "0",
	});
	await expect.poll(messages.text).toContain(": heartbeat");
	expect(messages.text()).not.toContain("before resume");
	await app.post("/api/messages", { topic: "stream/thread", body: "after resume" }, cookie);
	await expect.poll(messages.text).toContain("after resume");
	const requestStreams = await Promise.all([
		tail(test, `${app.url}/api/stream?since=0&types=http.request&limit=1`, credentials),
		tail(test, `${app.url}/api/stream?since=0&types=http.request&limit=1`, { cookie }),
	]);
	await fetch(`${app.url}/api/me`, { headers: credentials });
	for (const stream of requestStreams) {
		await expect.poll(stream.text).toContain(": heartbeat");
		expect(stream.text()).not.toContain("data:");
	}
	const resumed = await tail(test, `${app.url}/api/stream?types=message.*&topic=stream`, {
		...credentials,
		"last-event-id": String(first.seq),
	});
	await expect.poll(resumed.text).toContain("after resume");
	expect(resumed.text()).not.toContain("before resume");
}, 25000);

it("proxy closes otherwise idle app SSE on credential expiry and revocation", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie).catch(async () => {
		throw new Error(JSON.stringify(await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()));
	});
	const revoked = await tail(test, `${app.url}/api/stream?types=never.match`, await token(fixture, "revoked", 60000));
	const expiring = await tail(test, `${app.url}/api/stream?types=never.match`, await token(fixture, "expiring", 800));
	await expect.poll(revoked.text).toContain(": heartbeat");
	await fixture.sql("UPDATE tokens SET revoked_at=1 WHERE id='revoked'", "boot.db");
	await expect.poll(expiring.closed, { timeout: 2500 }).toBe(true);
	await expect.poll(revoked.closed, { timeout: 12000 }).toBe(true);
	expect(revoked.text()).not.toContain("data:");
	expect(expiring.text()).not.toContain("data:");
}, 20000);

it("replacement drains app event waits and closes SSE so clients resume on the next app", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie).catch(async () => {
		throw new Error(JSON.stringify(await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()));
	});
	const posted = await (await app.post("/api/messages", { topic: "reload-stream", body: "old app" }, cookie)).json();
	const stream = await tail(test, `${app.url}/api/stream?since=${posted.seq}&types=message.*&topic=reload-stream`, {
		cookie,
	});
	await expect.poll(stream.text).toContain(": heartbeat");
	const credentials = await token(fixture, "reload-reader", 60000);
	const waitingResponse = await fetch(
		`${app.url}/api/events?since=${posted.seq}&types=message.created&topic=reload-stream&wait=20`,
		{
			headers: credentials,
		},
	);
	expect(waitingResponse.status).toBe(200);
	const appWait = waitingResponse.json();
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
	expect(
		(
			await sourcePut(`${app.url}/api/fs/app/server.ts?reload=0`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: source + "\n// SSE replacement acceptance\n",
			})
		).status,
	).toBe(200);
	const reload = await app.post("/api/reload?release=1", {}, cookie);
	expect(await reload.json()).toMatchObject({ status: "live" });
	await expect.poll(stream.closed).toBe(true);
	const next = await (await app.post("/api/messages", { topic: "reload-stream", body: "new app" }, cookie)).json();
	const drained = await appWait;
	expect(drained).toMatchObject({ items: [], timed_out: false, drained: true });
	expect(drained.cursor).toBeGreaterThanOrEqual(posted.seq);
	expect(drained.cursor).toBeLessThan(next.seq);
	const resumedPage = await (
		await fetch(`${app.url}/api/events?since=${drained.cursor}&types=message.created&topic=reload-stream`, {
			headers: credentials,
		})
	).json();
	expect(resumedPage).toMatchObject({ items: [{ seq: next.seq }], drained: false });
	// A stream never echoes its own instance, so resume as the reader rather than the author.
	const resumed = await tail(test, `${app.url}/api/stream?types=message.*&topic=reload-stream`, {
		...credentials,
		"last-event-id": String(posted.seq),
	});
	await expect.poll(resumed.text).toContain("new app");
	expect(resumed.text()).not.toContain("old app");
}, 35000);

it("app event queries preserve filtered cursors, exclude self before pagination and enforce read authority", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const credentials = await token(fixture, "query-reader", 60000, '["read","write"]');
	const query = (params: string, headers: Record<string, string> = credentials) =>
		fetch(`${app.url}/api/events?${params}`, { headers });
	const docs = await (await fetch(`${app.url}/api`, { headers: { cookie } })).json();
	expect(docs.paths["/api/events"].get).toBeDefined();
	expect((await fetch(`${app.url}/api/events`)).status).toBe(401);
	expect((await query("", await token(fixture, "write-only", 60000, '["write"]'))).status).toBe(403);
	for (const params of [
		"limit=0",
		"wait=61",
		"since=1&since=2",
		"types=bad**",
		"topic=bad%2F%2Fpath",
		"level=fatal",
		"request_actor=rahul",
		"since=999999999999",
	])
		expect((await query(params)).status, params).toBe(400);
	const ownResponse = await fetch(`${app.url}/api/messages`, {
		method: "POST",
		headers: { ...credentials, "content-type": "application/json" },
		body: JSON.stringify({ topic: "event-query", body: "self message" }),
	});
	expect(ownResponse.status).toBe(200);
	const own = await ownResponse.json();
	const other = await (
		await app.post("/api/messages", { topic: "event-query/child", body: "other instance" }, cookie)
	).json();
	const first = await (await query("since=0&topic=event-query&types=message.created&limit=1")).json();
	expect(first.items).toMatchObject([{ seq: own.seq }]);
	const second = await (await query(`since=${first.cursor}&topic=event-query&types=message.created&limit=1`)).json();
	expect(second.items).toMatchObject([{ seq: other.seq }]);
	// A full first page of the caller's own messages must not hide another instance's event.
	const waiting = await (await query("since=0&topic=event-query&types=message.created&limit=1&wait=1")).json();
	expect(waiting).toMatchObject({ items: [{ seq: other.seq }], timed_out: false, drained: false });
	const empty = await (await query(`since=${other.seq}&topic=event-query&types=message.created&wait=1`)).json();
	expect(empty).toMatchObject({ items: [], timed_out: true, drained: false });
	expect(empty.cursor).toBeGreaterThanOrEqual(other.seq);
	const requests = await (await query("since=0&types=http.request&limit=200")).json();
	expect(requests.items).toEqual([]);
	const humanRequests = await (await query("since=0&types=http.request&limit=200", { cookie })).json();
	expect(humanRequests.items).toEqual([]);
	const diagnostics = await (await fetch(`${app.url}/_boot/events?since=0&limit=200`, { headers: credentials })).json();
	const ownRequests = diagnostics.items.filter((record: { type: string }) => record.type === "http.request");
	expect(ownRequests.length).toBeGreaterThan(0);
	for (const record of ownRequests) expect(record.actor).toBe("codex");
	// Sequence reservations are boot's own bookkeeping: they stay in boot's store and off the app feed.
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM events WHERE type='seq.reserved'", "boot.db")).not.toEqual([
		{ count: 0 },
	]);
	for (const headers of [credentials, { cookie }]) {
		expect((await (await query("since=0&types=seq.reserved&limit=200", headers)).json()).items).toEqual([]);
		const everything = await (await query("since=0&limit=200", headers)).json();
		expect(everything.items.filter((record: { type: string }) => record.type === "seq.reserved")).toEqual([]);
	}
}, 15000);

it("proxy closes app event waits on credential expiry, revocation and disconnect without leaking later events", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const url = `${app.url}/api/events?types=message.created&topic=auth-wait&wait=60`;
	const revoked = await tail(test, url, await token(fixture, "wait-revoked", 60000), "application/json");
	const expiring = await tail(test, url, await token(fixture, "wait-expiring", 800), "application/json");
	await fixture.sql("UPDATE tokens SET revoked_at=1 WHERE id='wait-revoked'", "boot.db");
	await expect.poll(expiring.closed, { timeout: 2500 }).toBe(true);
	const published = await app.post("/api/messages", { topic: "auth-wait", body: "after credentials ended" }, cookie);
	expect(published.status).toBe(200);
	await expect.poll(revoked.closed, { timeout: 2500 }).toBe(true);
	expect(revoked.text()).not.toContain("after credentials ended");
	expect(expiring.text()).not.toContain("after credentials ended");
	const disconnected = await tail(test, url, await token(fixture, "wait-disconnected", 60000), "application/json");
	await disconnected.stop();
	expect(disconnected.closed()).toBe(true);
	const next = await fetch(`${app.url}/api/events?since=0&types=message.created&topic=auth-wait`, {
		headers: { cookie },
	});
	expect(next.status).toBe(200);
	expect((await next.json()).items).toHaveLength(1);
}, 15000);

it("keeps the caller's own message events off SSE, matching the message and event waits", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const credentials = await token(fixture, "echo", 60000, '["read","write"]');
	const stream = await tail(test, `${app.url}/api/stream?topic=echo&types=message.*`, credentials);
	await expect.poll(stream.text).toContain(": heartbeat");
	const own = await fetch(`${app.url}/api/messages`, {
		method: "POST",
		headers: { ...credentials, "content-type": "application/json" },
		body: JSON.stringify({ topic: "echo", body: "my own write" }),
	});
	expect(own.status).toBe(200);
	expect((await app.post("/api/messages", { topic: "echo", body: "another instance" }, cookie)).status).toBe(200);
	await expect.poll(stream.text).toContain("another instance");
	expect(stream.text()).not.toContain("my own write");
	// The event long-poll already behaved this way; the two surfaces now agree.
	const waited = await (
		await fetch(`${app.url}/api/events?topic=echo&types=message.*&since=0&limit=50&wait=1`, { headers: credentials })
	).json();
	expect(waited.items.map((record: { payload: { body?: string } }) => record.payload.body)).not.toContain(
		"my own write",
	);
}, 20000);
