import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { EventRecord } from "../src/events.ts";
import { launch } from "./fixtures/proxy-launch.ts";

const requestEvent = Schema.Struct({
	...EventRecord.fields,
	payload: Schema.Struct({
		trace_id: Schema.String,
		span_id: Schema.String,
		method: Schema.String,
		path: Schema.String,
		status: Schema.Int,
		duration_ms: Schema.Finite,
		outcome: Schema.String,
	}).annotate({ parseOptions: { onExcessProperty: "error" } }),
});
const envelope = Schema.Struct({ items: Schema.Array(requestEvent), cursor: Schema.Int });
const decode = Schema.decodeUnknownSync(envelope);
const execute = promisify(execFile);
const inspect = async (data: string, statement: string) => {
	const { stdout } = await execute("bun", [
		join(import.meta.dirname, "fixtures/store.ts"),
		join(data, "boot.db"),
		statement,
	]);
	return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
};
// Logging tests inspect the durable writer through the real Events service, independently
// of the editable event-browsing HTTP product. Its publication fence still applies.
const recordedRequests = async (data: string) => {
	const { stdout } = await execute("bun", [
		join(import.meta.dirname, "fixtures/events-store.ts"),
		data,
		JSON.stringify({ op: "query", since: 0, types: ["http.request"] }),
	]);
	return Schema.decodeSync(
		Schema.fromJsonString(
			Schema.Struct({
				_tag: Schema.Literal("Success"),
				success: envelope,
			}),
		),
	)(stdout).success;
};
const seedAgent = async (data: string, name: string) => {
	const token = randomBytes(32).toString("base64url"),
		id = randomBytes(16).toString("hex");
	const hash = createHash("sha256").update(token).digest("hex");
	await inspect(
		data,
		`INSERT INTO tokens VALUES ('${id}','${id}','${id}','${name}','access','${hash}','test','["read"]',9999999999999,0,NULL,NULL,NULL,NULL)`,
	);
	return { id, headers: { authorization: `Bearer ${token}` } };
};

it("records child requests and authentication refusals without query, body, credential or forged identity contents", async (test) => {
	const app = await launch(test);
	await expect.poll(async () => (await app.state()).state).toBe("live");
	const response = await app.fetch(`${app.url}/echo?token=query-secret`, {
		method: "POST",
		headers: {
			"content-type": "text/plain",
			"x-comms-agent": "forged",
			"x-comms-request-id": "forged",
			"x-comms-assertion": "assertion-secret",
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			tracestate: "credential=secret",
			baggage: "credential=secret",
			"x-comms-traceparent": "forged",
		},
		body: "body-secret",
	});
	expect(response.headers.get("x-comms-span")).toBeNull();
	const echo: unknown = await response.json();
	if (typeof echo !== "object" || !echo || !("requestId" in echo)) throw new Error("Missing request id");
	expect(echo).toMatchObject({
		trace: expect.stringMatching(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/),
		publicTrace: expect.stringMatching(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/),
		traceState: null,
		baggage: null,
	});
	expect(JSON.stringify(echo)).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
	const query = () => recordedRequests(app.data);
	await expect.poll(async () => (await query()).items.length).toBe(1);
	const logged = (await query()).items[0];
	expect(logged).toMatchObject({
		actor: "rahul",
		instance: app.id,
		generation: 1,
		request_id: echo.requestId,
		topic: null,
		message_id: null,
		payload: { method: "POST", path: "/echo", status: 200, outcome: "completed" },
	});
	for (const secret of [
		"query-secret",
		"body-secret",
		"assertion-secret",
		"forged",
		"private/topic",
		"m_private",
		"private.ts",
		"annotations",
		app.cookie,
	])
		expect(JSON.stringify(logged)).not.toContain(secret);
	for (const headers of [{ "x-comms-agent": "forged" }, { authorization: "Bearer invalid", "x-comms-agent": "forged" }])
		expect((await fetch(`${app.url}/echo`, { headers })).status).toBe(401);
	await app.fetch(`${app.url}/health`);
	await app.fetch(`${app.url}/_boot/status`);
	const stream = await app.fetch(`${app.url}/_boot/events?since=${logged?.seq ?? 0}`);
	await stream.body?.cancel();
	await query();
	await query();
	await delay(100);
	expect((await query()).items).toHaveLength(3);
	const refused = (await query()).items.filter((event) => event.payload.status === 401);
	expect(refused).toHaveLength(2);
	for (const event of refused) expect(event).toMatchObject({ actor: "boot", instance: null, generation: 0 });
	const failed = await app.fetch(`${app.url}/disconnect`);
	expect(failed.status).toBe(503);
	await failed.text();
	await expect
		.poll(async () => (await query()).items.find((event) => event.payload.path === "/disconnect"))
		.toMatchObject({ level: "error", payload: { status: 503 } });
}, 10000);

it("logs completed streams after their last byte and disconnects once without retaining admission", async (test) => {
	const app = await launch(test, "controlled-stream");
	await expect.poll(async () => (await app.state()).state).toBe("live");
	const query = () => recordedRequests(app.data);
	const stream = await app.fetch(`${app.url}/stream`);
	const reader = stream.body?.getReader();
	if (!reader) throw new Error("Missing stream");
	expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
	// Hold the child open across the store-query subprocess. Reading the first
	// client chunk alone does not prevent the proxy from draining a timed stream.
	await delay(350); // Also verify that request duration includes the held body.
	expect((await query()).items).toHaveLength(0);
	expect((await app.fetch(`${app.url}/release-stream`, { method: "POST" })).status).toBe(204);
	expect(new TextDecoder().decode((await reader.read()).value)).toBe("second\n");
	expect((await reader.read()).done).toBe(true);
	await expect
		.poll(async () => (await query()).items.map((event) => event.payload.path).sort())
		.toEqual(["/release-stream", "/stream"]);
	expect((await query()).items.find((event) => event.payload.path === "/stream")).toMatchObject({
		payload: { path: "/stream", status: 200, outcome: "completed", duration_ms: expect.any(Number) },
	});
	const body = (await query()).items.find((event) => event.payload.path === "/stream")?.payload;
	if (!body) throw new Error("Missing duration");
	expect(body.duration_ms).toBeGreaterThan(300);
	const control = new AbortController();
	test.onTestFinished(() => control.abort());
	const held = await app.fetch(`${app.url}/hold-stream`, { method: "POST", signal: control.signal });
	const heldReader = held.body?.getReader();
	if (!heldReader) throw new Error("Missing held stream");
	await heldReader.read();
	control.abort();
	await heldReader.cancel().catch(() => {});
	await expect
		.poll(async () => (await query()).items.filter((event) => event.payload.path === "/hold-stream"))
		.toMatchObject([{ payload: { status: 200, outcome: "interrupted" } }]);
	await expect.poll(async () => (await app.fetch(`${app.url}/cancelled`)).text()).toBe("1");
	expect(await (await app.fetch(`${app.url}/_boot/status`)).json()).toMatchObject({
		traffic: { admitted: 0, queued: 0 },
	});
	await app.fetch(`${app.url}/empty`, { method: "HEAD" });
	await expect.poll(async () => (await query()).items.some((event) => event.payload.method === "HEAD")).toBe(true);
}, 10000);

it("fences stored request publication while direct boot diagnostics enforce actor visibility before pagination", async (test) => {
	const app = await launch(test, "normal", true);
	await expect.poll(async () => (await app.state()).state).toBe("live");
	const codex = await seedAgent(app.data, "codex"),
		claude = await seedAgent(app.data, "claude");
	const operation = async (op: string) => {
		const { stdout } = await execute("bun", [
			join(import.meta.dirname, "fixtures/events-store.ts"),
			app.data,
			JSON.stringify({ op, transaction: "http-test-pending", count: 1 }),
		]);
		expect(JSON.parse(stdout)).toMatchObject({ _tag: "Success" });
	};
	await operation("reserve");
	await (await fetch(`${app.url}/api/me`, { headers: codex.headers })).text();
	await expect
		.poll(async () =>
			inspect(app.data, "SELECT count(*) AS n FROM events WHERE json_extract(event,'$.type')='http.request'"),
		)
		.toEqual([{ n: 1 }]);
	// App publication remains fenced; independent recovery diagnostics deliberately do not wait.
	expect((await recordedRequests(app.data)).items).toHaveLength(0);
	const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ seq: Schema.Int })))(
		await inspect(app.data, "SELECT seq FROM events WHERE type='http.request' ORDER BY seq"),
	);
	const first = rows[0];
	if (!first) throw Error("Missing recorded request");
	const path = `${app.url}/_boot/events?since=${first.seq - 1}&limit=1`;
	expect(decode(await (await fetch(path, { headers: codex.headers })).json()).items).toMatchObject([
		{ actor: "codex", instance: codex.id },
	]);
	expect(decode(await (await fetch(path, { headers: claude.headers })).json()).items).toHaveLength(0);
	await operation("abort");
	expect((await recordedRequests(app.data)).items).toMatchObject([{ actor: "codex", instance: codex.id }]);
	expect(decode(await (await app.fetch(`${app.url}/api/events?since=0&types=http.request`)).json()).items).toHaveLength(
		0,
	);
	await (await fetch(`${app.url}/api/me`, { headers: claude.headers })).text();
	await expect
		.poll(async () => decode(await (await fetch(path, { headers: claude.headers })).json()).items)
		.toMatchObject([{ actor: "claude", instance: claude.id }]);
	expect(decode(await (await fetch(path, { headers: codex.headers })).json()).items).toMatchObject([
		{ actor: "codex", instance: codex.id },
	]);
	expect(decode(await (await app.fetch(`${app.url}/_boot/events?since=${first.seq - 1}`)).json()).items).toHaveLength(
		2,
	);
}, 10000);

it("finishes HTTP response and traffic cleanup while its diagnostic writer waits on the boot SQL connection", async (test) => {
	const child = spawn("bun", [join(import.meta.dirname, "fixtures/request-event-contention.ts")], {
		stdio: ["ignore", "pipe", "pipe"],
	});
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
	await expect.poll(() => /Listening (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1], { timeout: 5000 }).toBeTruthy();
	const url = /Listening (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
	if (!url) throw new Error(output);
	const stats = async (): Promise<unknown> => (await fetch(`${url}/stats`)).json();
	const holding = fetch(`${url}/hold`).then((response) => response.text());
	try {
		await expect.poll(stats).toMatchObject({ held: true });
		const response = await fetch(`${url}/request`, { method: "POST", signal: AbortSignal.timeout(1000) });
		expect(await response.text()).toBe("response complete");
		await expect
			.poll(stats, { timeout: 500 })
			.toMatchObject({ attempts: 1, written: 0, traffic: { admitted: 0, queued: 0 } });
		// A full diagnostic queue still admits and completes every request.
		for (let n = 0; n < 300; n++)
			expect(await (await fetch(`${url}/request`, { method: "POST" })).text()).toBe("response complete");
		expect(output).toContain("http.request event queue full");
		// Keep the shared SQL connection held beyond the previous nominal finalizer timeout.
		await delay(2100);
		expect(await stats()).toMatchObject({ written: 0, traffic: { admitted: 0 } });
	} finally {
		await fetch(`${url}/release`);
		await holding;
	}
	await expect.poll(stats, { timeout: 2000 }).toMatchObject({ written: 257 });
	await fetch(`${url}/fail`);
	expect(await (await fetch(`${url}/request`)).text()).toBe("response complete");
	await expect.poll(() => output).toContain("http.request event write failed");
	expect(output).not.toContain("private-diagnostic-secret");
	expect(await stats()).toMatchObject({ written: 257, traffic: { admitted: 0 } });
	await fetch(`${url}/repair`);
	await (await fetch(`${url}/request`)).text();
	await expect.poll(stats).toMatchObject({ written: 258 });
}, 7000);

it("records boot auth and enrollment failures and app-down replies once without feed self-logging", async (test) => {
	const app = await launch(test, "exit");
	await expect.poll(async () => (await app.state()).state, { timeout: 10000 }).toBe("failed");
	const query = () => recordedRequests(app.data);
	for (const path of ["/_boot/auth/login/verify", "/auth/enroll", "/auth/refresh"]) {
		const response = await fetch(`${app.url}${path}?secret=query-secret`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-comms-agent": "forged",
				"x-comms-assertion": "assertion-secret",
			},
			body: JSON.stringify({ name: "forged", secret: "body-secret" }),
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		await response.text();
	}
	const unavailable = await app.fetch(`${app.url}/echo`, { headers: { "x-boot-secret": "forged-secret" } });
	expect(unavailable.status).toBe(503);
	await unavailable.text();
	await expect.poll(async () => (await query()).items.length).toBe(4);
	const logged = (await query()).items;
	for (const event of logged.filter((event) => event.payload.path !== "/echo"))
		expect(event).toMatchObject({ actor: "boot", instance: null, generation: 0, payload: { outcome: "completed" } });
	expect(logged.find((event) => event.payload.path === "/echo")).toMatchObject({
		actor: "rahul",
		instance: app.id,
		generation: 0,
		payload: { status: 503 },
	});
	expect(new Set(logged.map((event) => event.request_id)).size).toBe(4);
	for (const secret of ["query-secret", "body-secret", "assertion-secret", "forged", app.cookie])
		expect(JSON.stringify(logged)).not.toContain(secret);
	for (const path of [
		"/health",
		"/_boot/status",
		"/api/events",
		"/_boot/events",
		"/api/stream",
		"/_boot/seq",
		"/_kernel/ping",
	])
		await (await app.fetch(`${app.url}${path}`)).text();
	await delay(100);
	expect((await query()).items).toHaveLength(4);
}, 15000);
