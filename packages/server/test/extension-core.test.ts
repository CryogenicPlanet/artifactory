import { refusalSchema } from "./fixtures/openapi-refusal.ts";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("loads core routes as an extension and keeps typed extension inputs, ownership and mutations consistent", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/a-typed.ts"),
		`
import {Effect, Schema} from "effect";
import {HttpApi,HttpApiBuilder,HttpApiEndpoint,HttpApiGroup,HttpApiSchema,OpenApi} from "effect/unstable/httpapi";
export default api => Effect.gen(function*(){
 yield* api.migrate("entries", "CREATE TABLE extension_entries(value TEXT,seq INTEGER)");
 const definition=HttpApi.make("typed-example").add(HttpApiGroup.make("typed").add(
  HttpApiEndpoint.post("post","/api/typed",{payload:Schema.Struct({value:Schema.String}),success:Schema.Struct({value:Schema.String})}).annotate(OpenApi.Description,"Store an entry atomically. Requires write."),
  HttpApiEndpoint.get("tree","/api/tree/:branch/*",{params:Schema.Struct({branch:Schema.String,"*":Schema.String}),success:Schema.String}).annotate(OpenApi.Description,"Read a branch subtree."),
  HttpApiEndpoint.post("leaf","/api/tree/:group/:leaf",{params:Schema.Struct({group:Schema.String,leaf:Schema.String}),success:Schema.String,error:Schema.Literal("custom_failure").pipe(HttpApiSchema.status(500))}).annotate(OpenApi.Description,"Write one leaf."),
  HttpApiEndpoint.get("get","/api/shape/:id",{params:Schema.Struct({id:Schema.String}),success:Schema.String}).annotate(OpenApi.Description,"Read an entry."),
  HttpApiEndpoint.post("named","/api/shape/:name",{params:Schema.Struct({name:Schema.String}),success:Schema.String}).annotate(OpenApi.Description,"Write an entry.")
 ));
 api.mount(definition,HttpApiBuilder.group(definition,"typed",h=>h
  .handle("post",({payload})=>Effect.gen(function*(){const ctx=yield* api.context("write");yield* ctx.emit("example.created",payload,seq=>ctx.db\`INSERT INTO extension_entries VALUES(\${payload.value},\${seq})\`.pipe(Effect.asVoid));return payload;}))
  .handle("tree",({params})=>Effect.succeed(params.branch))
  .handle("leaf",({params})=>Effect.succeed(params.group+":"+params.leaf))
  .handle("get",({params})=>Effect.succeed(params.id))
  .handle("named",({params})=>Effect.succeed(params.name))));
 api.route("GET","/api/owner",{description:"First owner",scope:"read",handler:async()=>Response.json("first")});
});`,
	);
	await writeFile(
		join(seed, "ext/b-conflict.ts"),
		`export default api=>api.route("GET","/api/owner",{description:"Conflicting later owner",scope:"read",handler:async()=>Response.json("second")});`,
	);
	await writeFile(
		join(seed, "ext/zz-post.ts"),
		`import { Effect } from "effect";
export default api => api.route("POST", "/api/messages", {description:"Custom message creation using public capabilities", scope:"write", handler:(request,ctx)=>Effect.gen(function*(){ const input=yield* request.json; return Response.json(yield* ctx.messages.create(input, request.headers["idempotency-key"])); })});`,
	);
	await writeFile(
		join(seed, "ext/c-mixed.ts"),
		`import { Cause, Effect } from "effect";
import {KernelError} from "../kernel/boot-channel.ts";
export default api=>api.route("GET","/api/mixed-cause",{description:"Exercise extension mixed failures",scope:"read",handler:()=>Effect.failCause(Cause.combine(Cause.fail(new KernelError({code:"boot_unavailable"})),Cause.die("mixed defect remains visible")))});`,
	);
	await writeFile(
		join(seed, "ext/d-mixed-input.ts"),
		`import {Cause, Effect, Schema} from "effect";
import {HttpApi,HttpApiBuilder,HttpApiEndpoint,HttpApiGroup,OpenApi} from "effect/unstable/httpapi";
import {HttpServerError,HttpServerRequest} from "effect/unstable/http";
export default api=>{const definition=HttpApi.make("mixed-input").add(HttpApiGroup.make("mixed-input").add(HttpApiEndpoint.get("mixed","/api/mixed-input",{success:Schema.String}).annotate(OpenApi.Description,"Exercise interrupted input failures")));
api.mount(definition,HttpApiBuilder.group(definition,"mixed-input",h=>h.handle("mixed",()=>Effect.gen(function*(){const request=yield* HttpServerRequest.HttpServerRequest;return yield* Effect.failCause(Cause.combine(Cause.die(new HttpServerError.HttpServerError({reason:new HttpServerError.RequestParseError({request})})),Cause.interrupt()));}))));};`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM messages WHERE instance<>'extension:system.ts'")).toEqual([
		{ count: 0 },
	]);
	const get = (path: string) => fetch(app.url + path, { headers: { cookie } });
	expect((await app.post("/api/messages", { topic: "core", body: "core extension works" }, cookie)).status).toBe(200);
	expect((await app.post("/api/typed", { value: 4 }, cookie)).status).toBe(400);
	expect((await app.post("/api/typed", { value: "atomic" }, cookie)).status).toBe(200);
	expect(await fixture.sql("SELECT value FROM extension_entries")).toEqual([{ value: "atomic" }]);
	const events = await (await get("/api/events?since=0&types=example.created")).json();
	expect(events.items).toHaveLength(1);
	expect(events.items[0].payload).toEqual({ value: "atomic" });
	expect(await (await get("/api/owner")).json()).toBe("first");
	const mixed = await get("/api/mixed-cause");
	expect(mixed.status).toBe(500);
	expect(await mixed.json()).toMatchObject({ error: { code: "extension_disabled", retriable: false } });
	const mixedInput = await get("/api/mixed-input");
	expect(mixedInput.status).toBe(500);
	expect(await mixedInput.json()).toMatchObject({ error: { code: "extension_disabled", retriable: false } });
	const statuses = await (await get("/api/ext")).json();
	expect(statuses).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: "core.ts",
				status: "loaded",
				registrations: expect.arrayContaining([
					expect.objectContaining({ path: "/api/messages" }),
					expect.objectContaining({ path: "/api/me" }),
				]),
			}),
			expect.objectContaining({ name: "a-typed.ts", status: "loaded" }),
			expect.objectContaining({
				name: "c-mixed.ts",
				status: "disabled",
				error: expect.stringContaining("mixed defect remains visible"),
			}),
			expect.objectContaining({
				name: "b-conflict.ts",
				status: "disabled",
				error: expect.stringContaining("a-typed.ts"),
			}),
		]),
	);
	// Core and extension writes must contend on the same publication instance.
	const concurrent = await Promise.all([
		app.post("/api/messages", { topic: "core", body: "concurrent core write" }, cookie),
		app.post("/api/typed", { value: "concurrent extension write" }, cookie),
	]);
	expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
	expect(await fixture.sql("SELECT body FROM messages WHERE body='concurrent core write'")).toEqual([
		{ body: "concurrent core write" },
	]);
	expect(await fixture.sql("SELECT value FROM extension_entries WHERE value='concurrent extension write'")).toEqual([
		{ value: "concurrent extension write" },
	]);
	expect((await get("/api/me")).status).toBe(200);
	const root = await get("/api/topics?mark=0");
	expect(root.status).toBe(200);
	expect(await root.json()).toMatchObject({ path: "" });
	expect(await (await app.post("/api/tree/docs/readme", {}, cookie)).json()).toBe("docs:readme");
	const docs = await (await get("/api")).json();
	expect(docs.paths["/api/tree/{branch}/{*}"].post.parameters).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ in: "path", name: "branch" }),
			expect.objectContaining({ in: "path", name: "*" }),
		]),
	);
	const leafErrors = refusalSchema(docs, docs.paths["/api/tree/{branch}/{*}"].post.responses[500]);
	expect(leafErrors).toContain("custom_failure");
	expect(leafErrors).toContain("extension_disabled");
	expect(docs.paths["/api/topics"].get).toMatchObject({ operationId: "topics.detail.root" });
	expect(docs.paths["/api/topics/{*}"].get.operationId).toBe("topics.detail");
	expect(
		docs.paths["/api/tree/{branch}"].get.parameters.filter((parameter: { in: string }) => parameter.in === "path"),
	).toEqual([expect.objectContaining({ name: "branch" })]);
	expect(docs.paths["/api/shape/{id}"].post.parameters).toEqual(
		expect.arrayContaining([expect.objectContaining({ in: "path", name: "id" })]),
	);
}, 25000);
