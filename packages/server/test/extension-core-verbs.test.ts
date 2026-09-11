import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("binds core handlers to public capabilities and protects generic extension mutations", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/core.ts"),
		`import { Effect } from "effect";
import type { Api } from "../kernel/extension-api.ts";
import { Api as CoreApi, coreHandlers } from "./core/api.ts";
export default (api: Api) => {
 const calls: Record<string, number> = {};
 const record = (name, effect) => Effect.sync(() => { calls[name] = (calls[name] ?? 0) + 1; }).pipe(Effect.andThen(effect));
 const wrapped: Api = {...api, context: scope => api.context(scope).pipe(Effect.map(ctx => ({...ctx,
  mutate: input => record("mutate", ctx.mutate(input)),
  messages: {...ctx.messages,
   create: (...args) => record("create", ctx.messages.create(...args)),
   query: (...args) => record("query", ctx.messages.query(...args))},
  topics: {...ctx.topics,
   read: (...args) => record("read", ctx.topics.read(...args)),
   meta: (...args) => record("meta", ctx.topics.meta(...args)),
   markRead: (...args) => record("markRead", ctx.topics.markRead(...args))}
 })))};
 api.mount(CoreApi, coreHandlers(wrapped));
 api.route("GET", "/api/verb-usage", {description:"Inspect core capability calls", scope:"read", handler:() => Effect.succeed(Response.json(calls))});
};`,
	);
	await writeFile(
		join(seed, "ext/protocol.ts"),
		`import { Effect, Schema } from "effect";
import type { Api } from "../kernel/extension-api.ts";
export default (api: Api) => Effect.gen(function* () {
 yield* api.migrate("entries", "CREATE TABLE protocol_entries(value TEXT,seq INTEGER)");
 const protocol = (ctx, mode, key) => ({
  ...(mode === "guard" ? {guard:ctx.messages.query({limit:1})} : {}),
  idempotency: {instance: mode === "foreign" ? "other-instance" : ctx.instance,
   ...(mode === "operational" ? {scope:"operational"} : {}),
   key, kind:"protocol.saved", input:mode, outcome:Schema.fromJsonString(Schema.Struct({seq:Schema.Int}))},
  body: reserve => Effect.gen(function* () {
   const range = yield* reserve(1);
   yield* ctx.db\`INSERT INTO protocol_entries VALUES(\${mode},\${range.from})\`;
   return {outcome:{seq:range.from}, events:[{
    seq:range.from, at:Date.now(), type:"protocol.saved", level:"info",
    actor:mode === "actor" ? "other-agent" : ctx.agent,
    instance:mode === "instance" ? "other-instance" : ctx.instance,
    request_id:mode === "request" ? "other-request" : ctx.request,
    generation:mode === "generation" ? ctx.generation + 1 : ctx.generation,
    topic:null, message_id:null, payload:{value:mode}
   }]};
  })
 });
 api.route("POST", "/api/protocol", {description:"Publish extension SQL and event atomically", scope:"write", handler:(request,ctx) =>
  ctx.mutate(protocol(ctx, ctx.query.mode ?? "valid", request.headers["idempotency-key"])).pipe(Effect.map(Response.json))});
 api.route("GET", "/api/protocol-read", {description:"Attempt mutation from a read capability", scope:"read", handler:(_request,ctx) =>
  ctx.mutate(ctx.query.mode === "effect"
   ? ctx.db\`INSERT INTO protocol_entries VALUES('read-effect',0)\`.pipe(Effect.asVoid)
   : protocol(ctx, "read-protocol", "read-protocol")).pipe(Effect.map(Response.json))});
});`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string) => fetch(app.url + path, { headers: { cookie } });
	const change = (method: string, path: string, body?: unknown) =>
		fetch(app.url + path, {
			method,
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const usage = async (): Promise<Record<string, number>> => (await get("/api/verb-usage")).json();
	const created = await app.post("/api/messages", { topic: "verbs", body: "original" }, cookie);
	expect(created.status).toBe(200);
	const message = await created.json();
	for (const [method, path, body] of [
		["PATCH", `/api/messages/${message.id}`, { body: "edited" }],
		["PUT", "/api/topics/verbs", { archived: true }],
		["PUT", "/api/topics/verbs", { archived: false }],
		["DELETE", `/api/messages/${message.id}`, undefined],
	] as const) {
		const before = (await usage()).mutate ?? 0;
		expect((await change(method, path, body)).status).toBe(200);
		expect((await usage()).mutate).toBe(before + 1);
	}
	expect((await change("PUT", "/api/topics/verbs", { meta: { purpose: "public verbs" } })).status).toBe(200);
	expect((await app.post("/api/messages", { topic: "verbs", body: "visible" }, cookie)).status).toBe(200);
	expect((await get("/api/messages?topic=verbs")).status).toBe(200);
	expect((await get("/api/topics/verbs")).status).toBe(200);
	const calls = await usage();
	for (const name of ["create", "query", "read", "meta", "markRead"]) expect(calls[name]).toBeGreaterThan(0);

	const saved = await app.post("/api/protocol", {}, cookie, "protocol-once");
	expect(saved.status).toBe(200);
	const outcome = await saved.json();
	const replay = await app.post("/api/protocol", {}, cookie, "protocol-once");
	expect(replay.status).toBe(200);
	expect(await replay.json()).toEqual(outcome);
	for (const mode of ["actor", "instance", "request", "generation", "foreign", "operational", "guard"]) {
		const refused = await app.post(`/api/protocol?mode=${mode}`, {}, cookie, `invalid-${mode}`);
		expect(refused.status, mode).toBe(400);
		expect(await refused.json()).toMatchObject({ error: { code: "input_invalid" } });
	}
	for (const mode of ["effect", "protocol"]) {
		const refused = await get(`/api/protocol-read?mode=${mode}`);
		expect(refused.status, mode).toBe(403);
		expect(await refused.json()).toMatchObject({ error: { code: "scope_required" } });
	}
	expect(await fixture.sql("SELECT value,seq FROM protocol_entries")).toEqual([{ value: "valid", seq: outcome.seq }]);
	const events = await (await get("/api/events?since=0&types=protocol.saved")).json();
	expect(events.items).toEqual([
		expect.objectContaining({ seq: outcome.seq, actor: "rahul", payload: { value: "valid" } }),
	]);
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM idempotency WHERE kind='protocol.saved'")).toEqual([
		{ count: 1 },
	]);
}, 30000);
