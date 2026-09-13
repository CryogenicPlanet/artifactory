import { sourcePut } from "./fixtures/source-put.ts";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

const owners = Schema.Array(Schema.Struct({ id: Schema.String, receipt: Schema.String }));
const status = Schema.Struct({ child: Schema.Struct({ generation: Schema.Number, pid: Schema.Number }) });
type App = Awaited<ReturnType<Awaited<ReturnType<typeof conversation>>["launch"]>>;
const headers = (cookie: string, proof: string) => ({
	cookie,
	origin: "https://comms.test",
	"content-type": "application/json",
	"x-chirp-assertion": proof,
});
const restart = (app: App, cookie: string, proof: string) =>
	fetch(`${app.url}/_boot/restart`, {
		method: "POST",
		headers: headers(cookie, proof),
		body: "{}",
		signal: AbortSignal.timeout(10000),
	});
const accept = async (app: App, cookie: string) => {
	const proof = await app.signedAssertion("boot.restart", {}, cookie);
	const response = await restart(app, cookie, proof);
	expect(response.status).toBe(202);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toEqual({ status: "restarting" });
	return proof;
};
const exited = async (app: App) => {
	await expect.poll(() => app.processHandle.exitCode, { timeout: 15000 }).toBe(0);
	expect(app.processHandle.signalCode).toBeNull();
};

it("refuses invalid restart HTTP requests and restarts to the newest good snapshot after delivering 202", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const challengeBody = { action: "boot.restart", params: {} };
	for (const [requestHeaders, expected] of [
		[{ origin: "https://comms.test" }, 401],
		[{ cookie }, 403],
		[{ cookie, origin: "https://evil.test" }, 403],
		[{ cookie, origin: "https://comms.test", authorization: `Bearer ${"a".repeat(43)}` }, 401],
	] satisfies ReadonlyArray<readonly [Readonly<Record<string, string>>, number]>) {
		for (const [path, body] of [
			["/_boot/auth/challenge", challengeBody],
			["/_boot/restart", {}],
		] as const) {
			const response = await fetch(`${app.url}${path}`, {
				method: "POST",
				headers: requestHeaders,
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(expected);
			await response.arrayBuffer();
		}
	}
	for (const params of [{ unexpected: true }, [], null])
		expect((await app.post("/_boot/auth/challenge", { action: "boot.restart", params }, cookie)).status).toBe(400);
	const valid = await app.signedAssertion("boot.restart", {}, cookie);
	for (const [path, method, body, expected] of [
		["/_boot/restart", "GET", undefined, 405],
		["/_boot/restart?unexpected=1", "POST", "{}", 400],
		["/_boot/restart", "POST", '{"unexpected":true}', 400],
		["/_boot/restart", "POST", "[]", 400],
		["/_boot/restart", "POST", "null", 400],
		["/_boot/restart", "POST", "{", 400],
	] as const) {
		const response = await fetch(`${app.url}${path}`, {
			method,
			headers: headers(cookie, valid),
			...(body === undefined ? {} : { body }),
		});
		expect(response.status).toBe(expected);
		await response.arrayBuffer();
	}
	expect((await app.post("/_boot/restart", {}, cookie)).status).toBe(401);
	expect((await restart(app, cookie, "invalid")).status).toBe(401);
	const another = await app.login();
	expect((await restart(app, another, valid)).status).toBe(401);
	const wrongAction = await app.signedAssertion("lock.break", { id: "00000000-0000-4000-8000-000000000001" }, cookie);
	expect((await restart(app, cookie, wrongAction)).status).toBe(401);
	expect(app.processHandle.exitCode).toBeNull();
	expect((await app.post("/api/messages", { topic: "restart", body: "retained" }, cookie)).status).toBe(200);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const updated = await sourcePut(`${app.url}/api/fs/app/ext/restart-marker.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: 'export default api => api.route("GET", "/api/restart-marker", {description:"Identify the retained generation",scope:"read",handler:()=>Response.json({version:2})});',
	});
	expect(await updated.json()).toMatchObject({ status: "live" });
	const before = Schema.decodeUnknownSync(status)(
		await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json(),
	);
	expect(before.child.generation).toBeGreaterThan(1);
	const closing = Schema.decodeUnknownSync(owners)(
		await fixture.sql("SELECT id,receipt FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
	);
	await writeFile(join(fixture.root, "app/server.ts"), "broken editable source");
	const proof = await accept(app, cookie);
	await exited(app);
	for (const owner of closing) expect(await readFile(owner.receipt, "utf8")).toBe(owner.id);
	expect(
		await fixture.sql("SELECT COUNT(*) AS count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
	).toEqual([{ count: 0 }]);
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	const after = Schema.decodeUnknownSync(status)(
		await (await fetch(`${resumed.url}/_boot/status`, { headers: { cookie } })).json(),
	);
	expect(after.child.generation).toBe(before.child.generation);
	expect(after.child.pid).not.toBe(before.child.pid);
	expect(await (await fetch(`${resumed.url}/api/restart-marker`, { headers: { cookie } })).json()).toEqual({
		version: 2,
	});
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='restart'")).toEqual([{ body: "retained" }]);
	expect((await restart(resumed, cookie, proof)).status).toBe(401);
	expect(resumed.processHandle.exitCode).toBeNull();
}, 60000);

it("finishes admitted publication before signed restart and refuses new public work", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed"),
		admitted = join(fixture.root, "admitted"),
		release = join(fixture.root, "release");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/held-write.ts"),
		`import {Effect,FileSystem} from "effect";
export default api => api.route("POST", "/api/held-write", {description:"Hold an admitted write",scope:"write",handler:(_request,ctx)=>Effect.gen(function*(){
 const fs=yield* FileSystem.FileSystem;yield* fs.writeFileString(${JSON.stringify(admitted)},"admitted");
 while(!(yield* fs.exists(${JSON.stringify(release)}))) yield* Effect.sleep("10 millis");
 return Response.json(yield* ctx.messages.create({topic:"restart-write",body:"retained during restart"},"restart-write"));
})});`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const pending = app
		.post("/api/held-write", {}, cookie)
		.then(async (response) => ({ status: response.status, body: await response.json() }));
	void pending.catch(() => undefined);
	await expect.poll(() => readFile(admitted, "utf8").catch(() => ""), { timeout: 5000 }).toBe("admitted");
	await accept(app, cookie);
	await expect
		.poll(
			async () => {
				const response = await fetch(`${app.url}/api/messages?mark=0`, { headers: { cookie } });
				await response.arrayBuffer();
				return response.status;
			},
			{ timeout: 3000 },
		)
		.toBe(503);
	expect(app.processHandle.exitCode).toBeNull();
	await writeFile(release, "release");
	expect(await pending).toMatchObject({ status: 200, body: { body: "retained during restart" } });
	await exited(app);
	const rows = [{ body: "retained during restart" }];
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='restart-write'")).toEqual(rows);
	const events =
		"SELECT json_extract(event,'$.payload.body') AS body FROM events WHERE json_extract(event,'$.type')='message.created' AND json_extract(event,'$.topic')='restart-write'";
	expect(await fixture.sql(events, "boot.db")).toEqual(rows);
	const resumed = await fixture.launch(join(seed, "server.ts"));
	await resumed.ready(cookie);
	expect(await fixture.sql(events, "boot.db")).toEqual(rows);
	expect((await fetch(`${resumed.url}/api/messages?topic=restart-write&mark=0`, { headers: { cookie } })).status).toBe(
		200,
	);
}, 40000);

it("retires a healthy-pinging child with a never-ending shutdown hook through its keeper", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/hang.ts"),
		'import {Effect} from "effect"; export default api=>api.on("shutdown",()=>Effect.never);',
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "hang", body: "retained" }, cookie)).status).toBe(200);
	const closing = Schema.decodeUnknownSync(owners)(
		await fixture.sql("SELECT id,receipt FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
	);
	expect(closing).toHaveLength(1);
	await accept(app, cookie);
	await exited(app);
	for (const owner of closing) expect(await readFile(owner.receipt, "utf8")).toBe(owner.id);
	expect(
		await fixture.sql("SELECT COUNT(*) AS count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
	).toEqual([{ count: 0 }]);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='hang'")).toEqual([{ body: "retained" }]);
}, 30000);

it("accepts signed restart while the application cannot start", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(join(seed, "server.ts"), 'throw new Error("broken child");');
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await expect
		.poll(
			async () => {
				const value = await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
				return value.child.state;
			},
			{ timeout: 15000 },
		)
		.toBe("failed");
	expect((await fetch(`${app.url}/api/messages`, { headers: { cookie } })).status).toBe(503);
	await accept(app, cookie);
	await exited(app);
}, 30000);

it("retires an unreleased admitted POST despite healthy ping and preserves its committed result", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed"),
		admitted = join(fixture.root, "admitted");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/never-write.ts"),
		`import {Effect,FileSystem} from "effect";
export default api=>api.route("POST","/api/never-write",{description:"Commit then retain an admitted request",scope:"write",handler:(_request,ctx)=>Effect.gen(function*(){
 yield* ctx.messages.create({topic:"uncertain-restart",body:"committed before response"},"uncertain-restart");
 yield* (yield* FileSystem.FileSystem).writeFileString(${JSON.stringify(admitted)},"admitted");
 return yield* Effect.never;
})});`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const pending = app
		.post("/api/never-write", {}, cookie)
		.then(async (response) => {
			await response.arrayBuffer();
			return response.status;
		})
		.catch(() => 0);
	await expect.poll(() => readFile(admitted, "utf8").catch(() => ""), { timeout: 5000 }).toBe("admitted");
	const before = Schema.decodeUnknownSync(status)(
		await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json(),
	);
	const closing = Schema.decodeUnknownSync(owners)(
		await fixture.sql("SELECT id,receipt FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
	);
	expect(closing).toHaveLength(1);
	// Other reads remain responsive while this admitted request keeps its lease.
	const readable = await fetch(`${app.url}/api/messages?mark=0`, { headers: { cookie } });
	expect(readable.status).toBe(200);
	await readable.arrayBuffer();
	expect(
		Schema.decodeUnknownSync(status)(await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json())
			.child.pid,
	).toBe(before.child.pid);
	await accept(app, cookie);
	await exited(app);
	await pending;
	for (const owner of closing) expect(await readFile(owner.receipt, "utf8")).toBe(owner.id);
	expect(
		await fixture.sql("SELECT COUNT(*) AS count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
	).toEqual([{ count: 0 }]);
	const resumed = await fixture.launch(join(seed, "server.ts"));
	await resumed.ready(cookie);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='uncertain-restart'")).toEqual([
		{ body: "committed before response" },
	]);
	expect(
		await fixture.sql(
			"SELECT COUNT(*) AS count FROM events WHERE json_extract(event,'$.type')='message.created' AND json_extract(event,'$.topic')='uncertain-restart'",
			"boot.db",
		),
	).toEqual([{ count: 1 }]);
}, 35000);

it("exits after keeper closure when a downstream client leaves an endless response unread", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/unread.ts"),
		'export default api=>api.route("GET","/api/unread",{description:"Backpressure a response",scope:"read",handler:()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));}}),{headers:{"content-type":"application/octet-stream"}})});',
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const abort = new AbortController();
	test.onTestFinished(() => abort.abort());
	const unread = await fetch(`${app.url}/api/unread`, { headers: { cookie }, signal: abort.signal });
	expect(unread.status).toBe(200);
	// Intentionally never consume/cancel this body until after the process has exited.
	const closing = Schema.decodeUnknownSync(owners)(
		await fixture.sql("SELECT id,receipt FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
	);
	expect(closing).toHaveLength(1);
	await accept(app, cookie);
	await expect
		.poll(
			async () =>
				await fixture.sql("SELECT COUNT(*) AS count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
			{ timeout: 12000 },
		)
		.toEqual([{ count: 0 }]);
	await expect.poll(() => app.processHandle.exitCode, { timeout: 20000 }).toBe(0);
	expect(app.processHandle.signalCode).toBeNull();
	for (const owner of closing) expect(await readFile(owner.receipt, "utf8")).toBe(owner.id);
	expect(
		await fixture.sql("SELECT COUNT(*) AS count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
	).toEqual([{ count: 0 }]);
	abort.abort();
}, 35000);
