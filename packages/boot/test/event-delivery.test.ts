import { agentHeader, authKindHeader } from "@comms/protocol/headers";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, type TestContext } from "vitest";

async function launch(test: TestContext) {
	const child = spawn("bun", [joinFixture()], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	test.onTestFinished(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = once(child, "exit");
		child.kill("SIGTERM");
		const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
		await exited;
		clearTimeout(kill);
	});
	await expect
		.poll(
			() => {
				if (child.exitCode !== null) throw new Error(output);
				return /Listening (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
			},
			{ timeout: 5000 },
		)
		.toBeTruthy();
	const url = /Listening (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
	if (!url) throw new Error(output);
	const get = (path: string, options?: RequestInit) => fetch(url + path, options);
	const post = (path: string, body: unknown, internal = false) =>
		get(path, {
			method: "POST",
			headers: { "content-type": "application/json", ...(internal ? { "x-boot-secret": "fixture-secret" } : {}) },
			body: JSON.stringify(body),
		});
	return { get, post, url };
}
const joinFixture = () => `${import.meta.dirname}/fixtures/event-delivery.ts`;
const event = (overrides: Record<string, unknown> = {}) => ({
	seq: 0,
	at: 1,
	type: "message.created",
	level: "info",
	actor: "other",
	instance: "other-family",
	generation: 1,
	request_id: null,
	topic: "project/thread",
	message_id: "m_1",
	payload: { body: "hello" },
	...overrides,
});
const json = async (response: Response): Promise<unknown> => response.json();

it("public diagnostics expose only bounded recovery events and reject application query features", async (test) => {
	const app = await launch(test);
	await app.post("/emit", event({ type: "generation.failed", payload: { error: "startup failed" } }));
	await app.post("/emit", event());
	expect(await json(await app.get("/_boot/events"))).toMatchObject({
		items: [{ type: "generation.failed" }],
		cursor: 2,
	});
	expect((await app.get("/api/events?since=0")).status).toBe(404);
	for (const query of [
		"wait=61",
		"types=generation.*",
		"topic=project",
		"since=0&since=1",
		"limit=201",
		"since=3",
		"since=",
	])
		expect((await app.get(`/_boot/events?${query}`)).status, query).toBe(400);
	expect((await app.get("/_boot/events", { headers: { "x-no-read": "1" } })).status).toBe(403);
	expect((await app.get("/_boot/events", { headers: { "x-test-human": "1" } })).status).toBe(200);
	const privatePage = await app.get("/_boot/events?since=0&types=message.*", {
		headers: { "x-boot-secret": "fixture-secret" },
	});
	expect(await json(privatePage)).toMatchObject({ items: [{ type: "message.created" }] });
});

it("event pages do not wait for the child channel gate", async (test) => {
	const app = await launch(test);
	const held = app.post("/hold", {});
	await expect.poll(async () => json(await app.get("/query-state"))).toMatchObject({ gateHeld: true });
	for (const headers of [{}, { "x-boot-secret": "fixture-secret" }])
		expect((await app.get("/_boot/events?since=0", { headers, signal: AbortSignal.timeout(1000) })).status).toBe(200);
	await held;
}, 6000);

it.for([false, true])(
	"a blocked event page cannot hold publication or retirement (child=%s)",
	async (internal, test) => {
		const app = await launch(test);
		const reading = app.get("/_boot/events?since=0", {
			headers: { "x-block-query": "1", ...(internal ? { "x-boot-secret": "fixture-secret" } : {}) },
		});
		await expect.poll(async () => json(await app.get("/query-state"))).toMatchObject({ blockedReads: 1 });
		const reserve = await app.get("/_boot/seq/reserve", {
			method: "POST",
			headers: { "content-type": "application/json", "x-boot-secret": "fixture-secret" },
			body: JSON.stringify({ transaction: "during-read", count: 1 }),
			signal: AbortSignal.timeout(1000),
		});
		expect(reserve.status).toBe(200);
		expect((await app.post("/_boot/seq/abort", { transaction: "during-read" }, true)).status).toBe(204);
		const retired = await app.get("/retire", { method: "POST", signal: AbortSignal.timeout(1000) });
		expect(retired.status).toBe(204);
		await app.post("/release-query", {});
		const response = await reading;
		expect(response.status).toBe(internal ? 403 : 200);
		if (internal) expect(await json(response)).toMatchObject({ error: { code: "stale_attempt", retriable: false } });
		else expect(await json(response)).toMatchObject({ cursor: 2 });
	},
);

it("event page timeout and disconnect interrupt the query", async (test) => {
	const app = await launch(test);
	const response = await app.get("/_boot/events?since=0", { headers: { "x-block-query": "1" } });
	expect(response.status).toBe(503);
	expect(await json(response)).toMatchObject({ error: { code: "events_unavailable", retriable: true } });
	await expect.poll(async () => json(await app.get("/query-state"))).toMatchObject({ blockedReads: 0 });
	const controller = new AbortController();
	test.onTestFinished(() => controller.abort());
	const reading = app
		.get("/_boot/events?since=0", {
			headers: { "x-block-query": "1" },
			signal: controller.signal,
		})
		.catch(() => undefined);
	await expect.poll(async () => json(await app.get("/query-state"))).toMatchObject({ blockedReads: 1 });
	controller.abort();
	await reading;
	await expect.poll(async () => json(await app.get("/query-state"))).toMatchObject({ blockedReads: 0 });
});

it("sequence fence requires the current child secret and exact host without forwarding headers", async (test) => {
	const app = await launch(test);
	expect((await app.get("/_boot/seq")).status).toBe(403);
	expect((await app.get("/_boot/seq", { headers: { "x-boot-secret": "wrong" } })).status).toBe(403);
	const headers = { "x-boot-secret": "fixture-secret" };
	for (const extra of [{ forwarded: "for=127.0.0.1" }, { "x-forwarded-host": "localhost" }])
		expect((await app.get("/_boot/seq", { headers: { ...headers, ...extra } })).status).toBe(403);
	const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
		const call = request(`${app.url}/_boot/seq`, { headers: { ...headers, host: "localhost:1" } }, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode));
		});
		call.on("error", reject);
		call.end();
	});
	expect(wrongHost).toBe(403);
	const fence = await app.get("/_boot/seq", { headers });
	expect(fence.status).toBe(200);
	expect(await json(fence)).toEqual({ published_through: 0 });
	expect((await app.post("/_boot/seq", {}, true)).status).toBe(405);
	expect((await app.get("/_boot/agents", { headers })).status).toBe(404);
	await app.post("/retire", {});
	expect((await app.get("/_boot/seq", { headers })).status).toBe(403);
});

it("read-scoped boot waits survive a stuck app fence without exposing private failure detail", async (test) => {
	const app = await launch(test);
	await app.post("/failed-generation", {});
	expect((await app.post("/_boot/seq/reserve", { transaction: "stuck", count: 1 }, true)).status).toBe(200);
	const headers = { "x-read-only": "1" };
	const response = await app.get("/_boot/events?since=2&wait=2", { headers });
	const waiting = response.json();
	await app.post("/emit", event({ type: "generation.failed", payload: {} }));
	expect(await waiting).toMatchObject({
		items: [{ seq: 3, type: "generation.failed" }],
		cursor: 3,
		timed_out: false,
		drained: false,
	});
	const read = await (await app.get("/_boot/events?since=0", { headers })).text();
	expect(read).not.toContain("private stderr");
	expect(read).not.toContain("private error");
	const privileged = await json(await app.get("/_boot/events?since=0"));
	expect(privileged).toMatchObject({ items: [{ current_failure: { stderr: "private stderr" } }] });
	expect(
		await json(await app.get("/_boot/events?since=0", { headers: { "x-boot-secret": "fixture-secret" } })),
	).toMatchObject({ items: [], cursor: 0 });
});

it("boot event waits stop on revocation and captured expiry before delivering new diagnostics", async (test) => {
	const app = await launch(test);
	const issued = await (await app.post("/token", {})).json();
	for (const headers of [{ authorization: `Bearer ${issued.token}` }, { "x-short-expiry": "1" }]) {
		const cursor = await json(await app.get("/_boot/events?limit=1"));
		if (typeof cursor !== "object" || cursor === null || !("cursor" in cursor)) throw Error("Missing cursor");
		const response = await app.get(`/_boot/events?since=${cursor.cursor}&wait=2`, { headers });
		const waiting = response.json();
		if (headers.authorization) await app.post("/revoke", {});
		else await delay(450);
		await app.post("/emit", event({ type: "lock.released", payload: { marker: "must not deliver" } }));
		expect(await waiting).toMatchObject({ items: [], drained: true, timed_out: false });
	}
});

it("private child queries cannot widen request diagnostics with absent or forged caller metadata", async (test) => {
	const app = await launch(test);
	await app.post("/emit", event({ type: "http.request", actor: "codex", payload: { path: "/own" } }));
	await app.post("/emit", event({ type: "http.request", actor: "claude", payload: { path: "/other" } }));
	for (const suffix of ["", "&request_actor=codex", "&request_actor=claude"]) {
		const response = await app.get(`/_boot/events?since=0&types=http.request${suffix}`, {
			headers: { "x-boot-secret": "fixture-secret", [agentHeader]: "claude", [authKindHeader]: "human" },
		});
		expect(await json(response)).toMatchObject({ items: [], cursor: 2 });
	}
	const own = await json(await app.get("/_boot/events?since=0", { headers: { "x-read-only": "1" } }));
	expect(own).toMatchObject({ items: [{ actor: "codex", payload: { path: "/own" } }], cursor: 2 });
	expect(JSON.stringify(own)).not.toContain("/other");
	const human = await json(await app.get("/_boot/events?since=0", { headers: { "x-test-human": "1" } }));
	expect(human).toMatchObject({ items: [{ actor: "codex" }, { actor: "claude" }], cursor: 2 });
	expect((await app.get("/_boot/events?since=0&request_actor=claude")).status).toBe(400);
	await app.post("/emit", event({ type: "message.created" }));
	expect(
		await json(await app.get("/_boot/events?since=0", { headers: { "x-boot-secret": "fixture-secret" } })),
	).toMatchObject({ items: [{ type: "message.created" }], cursor: 3 });
});

it("revalidates public authority before returning an empty diagnostic cursor", async (test) => {
	const app = await launch(test);
	const issued = await (await app.post("/token", {})).json();
	const reading = app.get("/_boot/events?since=0", {
		headers: { authorization: `Bearer ${issued.token}`, "x-block-query": "1" },
	});
	await expect.poll(async () => json(await app.get("/query-state"))).toMatchObject({ blockedReads: 1 });
	await app.post("/revoke", {});
	await app.post("/release-query", {});
	const response = await reading;
	expect(response.status).toBe(401);
	expect(await json(response)).toMatchObject({ error: { code: "credential_invalid" } });
});
