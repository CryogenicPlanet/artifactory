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

it("withholds the publication gap, filters before pagination, resumes without skipping visible rows", async (test) => {
	const app = await launch(test);
	expect((await app.post("/_boot/seq/reserve", { transaction: "pending", count: 1 }, true)).status).toBe(200);
	await app.post("/emit", event({ type: "http.request", actor: "other" }));
	await app.post("/emit", event({ topic: "project-other" }));
	await app.post("/emit", event());
	expect(await json(await app.get("/api/events?since=0"))).toMatchObject({ items: [], cursor: 0 });
	expect((await app.get("/api/events?since=1")).status).toBe(400);
	const waiting = app.get("/_boot/events?since=0&topic=project&wait=2&limit=1").then(json);
	await delay(150);
	expect((await app.post("/_boot/seq/abort", { transaction: "pending" }, true)).status).toBe(204);
	expect(await waiting).toMatchObject({ items: [{ seq: 4 }], cursor: 4, timed_out: false, drained: false });
	expect(await json(await app.get("/api/events?since=0&limit=1"))).toMatchObject({ items: [{ seq: 3 }], cursor: 3 });
	expect(await json(await app.get("/api/events?since=3&limit=1"))).toMatchObject({ items: [{ seq: 4 }], cursor: 4 });
	expect(
		await json(await app.get("/api/events?since=0&types=http.*", { headers: { "x-test-human": "1" } })),
	).toMatchObject({ items: [{ seq: 2 }] });
}, 10000);

it("wait excludes own messages, keeps empty cursor, and omitted since starts at the published fence", async (test) => {
	const app = await launch(test);
	await app.post("/emit", event({ instance: "caller-family", actor: "codex" }));
	expect(await json(await app.get("/api/events?since=0&wait=1"))).toEqual({
		items: [],
		cursor: 0,
		timed_out: true,
		drained: false,
	});
	expect(await json(await app.get("/api/events"))).toEqual({ items: [], cursor: 1, timed_out: false, drained: false });
	expect(await json(await app.get("/api/events?since=0"))).toMatchObject({ items: [{ seq: 1 }] });
	await app.post("/emit", event());
	expect(await json(await app.get("/api/events?since=0&wait=1&limit=1"))).toMatchObject({
		items: [{ seq: 2 }],
		cursor: 2,
	});
	for (const query of [
		"wait=61",
		"since=",
		"limit=0",
		"since=0&since=1",
		"topic=a//b",
		"types=x**",
		"level=fatal",
		"wat=1",
	])
		expect((await app.get(`/api/events?${query}`)).status, query).toBe(400);
	expect((await app.get("/api/stream", { headers: { "last-event-id": "nope" } })).status).toBe(400);
	expect((await app.get("/api/stream", { headers: { "x-no-read": "1" } })).status).toBe(403);
}, 10000);

it("SSE resumes, survives child retirement, emits heartbeats, and disconnect stops polling", async (test) => {
	const app = await launch(test);
	await app.post("/emit", event());
	await app.post("/emit", event({ instance: "caller-family" }));
	const longBody = app.get("/api/events?since=2&types=no.match&wait=11").then((response) => response.text());
	const controller = new AbortController();
	test.onTestFinished(() => controller.abort());
	const response = await app.get("/api/stream?limit=1", {
		headers: { "last-event-id": "1" },
		signal: controller.signal,
	});
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing stream");
	let received = "";
	const readUntil = async (needle: string) => {
		while (!received.includes(needle)) {
			const part = await reader.read();
			if (part.done) throw new Error("Stream ended");
			received += new TextDecoder().decode(part.value);
		}
	};
	await readUntil("id: 2\n");
	expect(received).not.toContain("id: 1\n");
	await app.post("/retire", {});
	await app.post("/emit", event());
	await readUntil("id: 3\n");
	await readUntil(": heartbeat\n\n");
	const started = performance.now();
	received = "";
	await readUntil(": heartbeat\n\n");
	expect(performance.now() - started).toBeGreaterThan(8500);
	controller.abort();
	await reader.cancel().catch(() => {});
	await delay(300);
	const body = await longBody;
	expect(body.startsWith("\n\n")).toBe(true);
	expect(JSON.parse(body)).toEqual({ items: [], cursor: 2, timed_out: true, drained: false });
	const stopped = await json(await app.get("/stats"));
	await delay(300);
	expect(await json(await app.get("/stats"))).toEqual(stopped);
}, 15000);

it("long-poll deadline includes channel admission and disconnect interrupts a blocked read", async (test) => {
	const app = await launch(test);
	const started = performance.now();
	const waiting = await app.get("/api/events?since=0&wait=1");
	const held = app.post("/hold", {});
	expect(await json(waiting)).toEqual({ items: [], cursor: 0, timed_out: true, drained: false });
	expect(performance.now() - started).toBeLessThan(1800);
	await held;
}, 6000);

it("revoked credentials and captured expiry stop an open stream before new events are delivered", async (test) => {
	const app = await launch(test);
	const issued = await json(await app.post("/token", {}));
	if (typeof issued !== "object" || issued === null || !("token" in issued) || typeof issued.token !== "string")
		throw new Error("No token");
	for (const headers of [{ authorization: `Bearer ${issued.token}` }, { "x-short-expiry": "1" }]) {
		const controller = new AbortController();
		test.onTestFinished(() => controller.abort());
		const responses = await Promise.all(
			["/api/stream", "/api/events?wait=2"].map((path) => app.get(path, { headers, signal: controller.signal })),
		);
		const readers = responses.map((response) => {
			const reader = response.body?.getReader();
			if (!reader) throw new Error("No stream");
			return reader;
		});
		await Promise.all(readers.map((reader) => reader.read()));
		if (headers.authorization) await app.post("/revoke", {});
		else await delay(450);
		await app.post("/emit", event({ payload: { private: "must-not-deliver" } }));
		for (const reader of readers) {
			let body = "";
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					body += new TextDecoder().decode(next.value);
				}
			} catch {
				/* Refusal closes an already-open response. */
			}
			expect(body).not.toContain("must-not-deliver");
		}
		controller.abort();
	}
}, 5000);

it("roster requires the current child secret and exact host without forwarding headers", async (test) => {
	const app = await launch(test);
	expect((await app.get("/_boot/agents")).status).toBe(403);
	expect((await app.get("/_boot/agents", { headers: { "x-boot-secret": "wrong" } })).status).toBe(403);
	const headers = { "x-boot-secret": "fixture-secret" };
	for (const extra of [{ forwarded: "for=127.0.0.1" }, { "x-forwarded-host": "localhost" }])
		expect((await app.get("/_boot/agents", { headers: { ...headers, ...extra } })).status).toBe(403);
	const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
		const call = request(`${app.url}/_boot/agents`, { headers: { ...headers, host: "localhost:1" } }, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode));
		});
		call.on("error", reject);
		call.end();
	});
	expect(wrongHost).toBe(403);
	const roster = await app.get("/_boot/agents", { headers });
	expect(roster.status).toBe(200);
	expect(roster.headers.get("cache-control")).toBe("no-store");
	expect(await json(roster)).toEqual({ items: [] });
	expect((await app.post("/_boot/agents", {}, true)).status).toBe(405);
	await app.post("/retire", {});
	expect((await app.get("/_boot/agents", { headers })).status).toBe(403);
});
