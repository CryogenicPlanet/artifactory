/* oxlint-disable effecttsgo/global-date -- Native HTTP integration uses the real process wall clock. */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("enrolls two agents with signed approval, isolates scopes and attribution, filters request events before pagination", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const grant = async (name: string, scopes: readonly string[], long_lived = false) => {
		const created = await app.post("/auth/enroll", { name, kind: "codex", host: "laptop" });
		expect(created.status).toBe(200);
		const enrollment = await created.json();
		expect(enrollment.approve_url).toBe(`https://comms.test/approve/${enrollment.id}`);
		expect(enrollment.qr_ascii).toContain("█");
		const page = await fetch(`${app.url}/approve/${enrollment.id}`);
		expect(page.status).toBe(200);
		expect(page.headers.get("cache-control")).toBe("no-store");
		const html = await page.text();
		expect(html).toContain(enrollment.user_code);
		expect(html).not.toContain(enrollment.device_secret);
		const svg = await fetch(`${app.url}/_boot/approve/${enrollment.id}.svg`);
		expect(svg.headers.get("content-type")).toContain("image/svg+xml");
		expect((await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })).status).toBe(
			202,
		);
		expect((await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.user_code })).status).toBe(401);
		const params = { id: enrollment.id, decision: "approve" as const, scopes, long_lived };
		const assertion = await app.assertion(params);
		const decision = await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
			method: "POST",
			headers: { origin: "https://comms.test", "content-type": "application/json", "x-comms-assertion": assertion },
			body: JSON.stringify({ decision: params.decision, scopes, long_lived }),
		});
		expect(decision.status).toBe(200);
		expect(decision.headers.get("set-cookie")).toBeNull();
		const responses = await Promise.all([
			app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret }),
			app.post(`/_boot/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret }),
		]);
		expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 410]);
		const collected = responses.find((response) => response.status === 200);
		if (!collected) throw new Error("Missing collection");
		const pair = await collected.json();
		expect(pair.agent).toBe(name);
		expect(pair.scopes).toEqual(scopes);
		expect(pair.label).toBe("laptop");
		for (const secret of [enrollment.device_secret, pair.access, pair.refresh])
			expect(app.output()).not.toContain(secret);
		return { enrollment, pair };
	};
	const codex = await grant("codex", ["read", "write"]),
		claude = await grant("claude", ["read", "write"], true),
		reader = await grant("reader", ["read"]),
		writer = await grant("writer", ["write"]);
	expect(claude.pair.expires_at - Date.now()).toBeGreaterThan(6.9 * 86400000);
	const call = (path: string, access: string, body?: unknown) =>
		fetch(`${app.url}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${access}`,
				"content-type": "application/json",
				"x-comms-agent": "rahul",
				"x-comms-auth-kind": "human",
				"x-comms-scopes": "admin",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const first = await call("/api/messages", codex.pair.access, { topic: "project/thread", body: "Question" });
	expect(first.status).toBe(200);
	const message = await first.json();
	expect(message.agent).toBe("codex");
	expect(message.instance).toBe(codex.pair.family);
	const wait = call(`/api/messages?topic=project/thread&since=${message.seq}&wait=5`, codex.pair.access);
	const reply = await call("/api/messages", claude.pair.access, { topic: "project/thread", body: "Answer" });
	expect(reply.status).toBe(200);
	const response = await (await wait).json();
	expect(response.items).toHaveLength(1);
	expect(response.items[0].agent).toBe("claude");
	expect((await call("/api/messages", reader.pair.access, { topic: "project", body: "forbidden" })).status).toBe(403);
	expect((await call("/api/messages?since=0", writer.pair.access)).status).toBe(403);
	expect((await call("/api/events?since=0", writer.pair.access)).status).toBe(403);
	expect((await call("/_boot/status", reader.pair.access)).status).toBe(403);
	expect((await call("/api/messages", codex.pair.refresh)).status).toBe(401);
	const badBearer = await fetch(`${app.url}/api/messages`, { headers: { cookie, authorization: "Bearer bad" } });
	expect(badBearer.status).toBe(401);
	expect(
		(
			await fetch(`${app.url}/_boot/auth/logout`, {
				method: "POST",
				headers: { cookie, authorization: `Bearer ${codex.pair.access}`, origin: "https://comms.test" },
			})
		).status,
	).toBe(401);
	for (const [seq, actor] of [
		[1000, "claude"],
		[1001, "codex"],
		[1002, "claude"],
	] as const) {
		const event = {
			seq,
			at: Date.now(),
			type: "http.request",
			level: "info",
			actor,
			instance: null,
			generation: 1,
			request_id: null,
			topic: null,
			message_id: null,
			payload: {},
		};
		await fixture.sql(`INSERT INTO events(seq,event) VALUES(${seq},'${JSON.stringify(event)}')`, "boot.db");
	}
	await fixture.sql("UPDATE seq SET next=1003,published_through=1002", "boot.db");
	const filtered = await (await call("/api/events?since=999&limit=1", codex.pair.access)).json();
	expect(filtered.items.map((event: { actor: string }) => event.actor)).toEqual(["codex"]);
	expect(filtered.cursor).toBe(1001);
	expect(await (await call("/api/events?since=1001&limit=1", codex.pair.access)).json()).toMatchObject({
		items: [],
		cursor: 1001,
	});
	const human = await fetch(`${app.url}/api/events?since=999`, { headers: { cookie } });
	expect((await human.json()).items).toHaveLength(3);
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(
		(await fetch(`${resumed.url}/api/messages?since=0`, { headers: { authorization: `Bearer ${codex.pair.access}` } }))
			.status,
	).toBe(200);
	expect(
		(await resumed.post(`/auth/enroll/${codex.enrollment.id}`, { device_secret: codex.enrollment.device_secret }))
			.status,
	).toBe(410);
}, 30000);

it("rejects unknown action fields, binds grants, requires exact Origin, and approves while app recovery is unavailable", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await app.stop();
	await rm(join(fixture.root, "comms.db"));
	const down = await fixture.launch();
	const enrollment = await (await down.post("/auth/enroll", { name: "codex", kind: "codex", host: "laptop" })).json();
	const params = { id: enrollment.id, decision: "approve" as const, scopes: ["read", "write"], long_lived: false };
	for (const body of [
		{ action: "db.restore", params },
		{ action: "enrollment.decide", params: { ...params, extra: true } },
		{ action: "enrollment.decide", params, extra: true },
	])
		expect((await down.post("/_boot/auth/challenge", body)).status).toBe(400);
	const proof = await down.assertion(params);
	const decide = (input: unknown, origin = "https://comms.test", assertion = proof) =>
		fetch(`${down.url}/_boot/enroll/${enrollment.id}/approve`, {
			method: "POST",
			headers: { origin, "content-type": "application/json", "x-comms-assertion": assertion },
			body: JSON.stringify(input),
		});
	const input = { decision: params.decision, scopes: params.scopes, long_lived: false };
	expect((await decide({ ...input, extra: true })).status).toBe(400);
	expect((await decide({ ...input, long_lived: true })).status).toBe(401);
	expect((await decide(input, "https://evil.test")).status).toBe(403);
	expect([401, 431]).toContain((await decide(input, "https://comms.test", "a".repeat(17000))).status);
	const waiting = down.post(`/auth/enroll/${enrollment.id}?wait=5`, { device_secret: enrollment.device_secret });
	expect((await decide(input)).status).toBe(200);
	const collected = await waiting;
	expect(collected.status).toBe(200);
	const pair = await collected.json();
	expect(
		(await fetch(`${down.url}/api/messages`, { headers: { authorization: `Bearer ${pair.access}` } })).status,
	).toBe(503);
	expect((await decide(input)).status).toBe(401);
	const denial = await (await down.post("/auth/enroll", { name: "claude", kind: "claude", host: "laptop" })).json();
	const deniedParams = { id: denial.id, decision: "deny" as const, scopes: [], long_lived: false };
	const denyProof = await down.assertion(deniedParams);
	expect(
		(
			await fetch(`${down.url}/_boot/enroll/${denial.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", "x-comms-assertion": denyProof },
				body: JSON.stringify({ decision: "deny", scopes: [], long_lived: false }),
			})
		).status,
	).toBe(200);
	expect((await down.post(`/auth/enroll/${denial.id}`, { device_secret: denial.device_secret })).status).toBe(403);
	for (const wait of ["61", "-1", "nope", ""])
		expect(
			(await down.post(`/auth/enroll/${denial.id}?wait=${wait}`, { device_secret: denial.device_secret })).status,
		).toBe(400);
}, 15000);
