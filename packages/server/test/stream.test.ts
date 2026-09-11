import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

async function tail(test: TestContext, url: string, headers: Record<string, string>) {
	const controller = new AbortController();
	const response = await fetch(url, { headers, signal: controller.signal });
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
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

it("app SSE resumes and filters at the boot publication boundary without leaking another actor's request events", async (test) => {
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
	const ownRequests = await tail(test, `${app.url}/api/stream?since=0&types=http.request&limit=1`, credentials);
	await fetch(`${app.url}/api/me`, { headers: credentials });
	await expect.poll(ownRequests.text).toContain('"actor":"codex"');
	expect(ownRequests.text()).not.toContain('"actor":"rahul"');
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

it("replacement closes app SSE while boot event waits survive and the client resumes on the next app", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie).catch(async () => {
		throw new Error(JSON.stringify(await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()));
	});
	const posted = await (await app.post("/api/messages", { topic: "reload-stream", body: "old app" }, cookie)).json();
	const stream = await tail(test, `${app.url}/api/stream?since=${posted.seq}&types=message.*`, { cookie });
	await expect.poll(stream.text).toContain(": heartbeat");
	const bootWait = fetch(`${app.url}/api/events?since=${posted.seq}&types=message.created&wait=20`, {
		headers: await token(fixture, "reload-reader", 60000),
	}).then((response) => response.json());
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
	expect(
		(
			await fetch(`${app.url}/api/fs/app/server.ts?reload=0`, {
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
	expect(await bootWait).toMatchObject({ items: [{ seq: next.seq }], drained: false });
	const resumed = await tail(test, `${app.url}/api/stream?types=message.*`, {
		cookie,
		"last-event-id": String(posted.seq),
	});
	await expect.poll(resumed.text).toContain("new app");
	expect(resumed.text()).not.toContain("old app");
}, 35000);
