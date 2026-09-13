import { refusalSchema } from "./fixtures/openapi-refusal.ts";
import { sourcePut } from "./fixtures/source-put.ts";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("matches scoped parameter and wildcard routes with the same context and descriptions", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "route-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/core.ts"),
		`import {CoreApi} from "@comms/protocol";
import {coreHandlers} from "./core/api.ts";
export default api => {
 api.mount(CoreApi,coreHandlers(api));
 api.route("GET", "/api/route-demo/:id", {description:"Old parameter route",scope:"read",handler:async()=>Response.json("old")});
 api.route("GET", "/api/route-demo/fixed", {description:"Fixed route",scope:"read",handler:async()=>Response.json("fixed")});
};`,
	);
	await writeFile(
		join(seed, "ext/zz-routes.ts"),
		`import {Effect} from "effect";
import {HttpRouter,HttpServerRequest} from "effect/unstable/http";
export default api => {
 api.route("GET", "/api/route-demo/:name", {description:"Selected parameter route",scope:"read",handler:(req,ctx)=>Effect.gen(function*(){
  const request=yield* HttpServerRequest.HttpServerRequest;
  return Response.json({agent:ctx.agent,params:ctx.params,query:ctx.query,nativeParams:yield* HttpRouter.params,nativeQuery:yield* HttpServerRequest.ParsedSearchParams,headers:request.headers,sourceHeaders:Object.fromEntries(req.source.headers)});
 })});
 api.route("GET", "/api/files/:bucket/*", {description:"Nested files",scope:"read",handler:async(req,ctx)=>Response.json(ctx.params)});
 api.route("POST", "/api/files/:container/:file", {description:"Single file write",scope:"write",handler:async(req,ctx)=>Response.json(ctx.params)});
 api.route("POST", "/api/route-demo/:target", {description:"Write route",scope:"write",handler:async(req,ctx)=>Response.json({method:req.method,params:ctx.params})});
 api.route("HEAD", "/api/route-demo/:name", {description:"Explicit HEAD",scope:"read",handler:async()=>new Response(null,{headers:{"x-route":"head"}})});
 api.route("OPTIONS", "/api/route-demo/:name", {description:"Explicit OPTIONS",scope:"read",handler:async()=>new Response(null,{headers:{"x-route":"options"}})});
};`,
	);
	await writeFile(
		join(seed, "ext/invalid.ts"),
		`export default api => api.route("GET", "/api/bad/*/suffix", {description:"Bad pattern",scope:"read",handler:async()=>Response.json("bad")});`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string) => fetch(`${app.url}${path}`, { headers: { cookie, "x-chirp-agent": "spoof" } });
	const result = await (await get("/api/route-demo/hello%20world?tag=one&tag=two&since=12")).json();
	expect(result).toMatchObject({
		agent: "rahul",
		params: { name: "hello world" },
		query: { tag: ["one", "two"], since: "12" },
		nativeParams: { name: "hello world" },
		nativeQuery: { tag: ["one", "two"], since: "12" },
	});
	for (const secret of ["x-boot-secret", "authorization", "cookie"]) {
		expect(result.headers[secret]).toBeUndefined();
		expect(result.sourceHeaders[secret]).toBeUndefined();
	}
	expect(await (await get("/api/route-demo/fixed")).json()).toBe("fixed");
	expect(await (await get("/api/files/docs/nested/read%20me.md")).json()).toEqual({
		bucket: "docs",
		"*": "nested/read me.md",
	});
	expect(await (await get("/api/files/docs/")).json()).toEqual({ bucket: "docs", "*": "" });
	expect((await get("/api/files/docs")).status).toBe(404);
	expect((await get("/api/route-demo/value/extra")).status).toBe(404);
	for (const method of ["HEAD", "OPTIONS"]) {
		const response = await fetch(`${app.url}/api/route-demo/value`, { method, headers: { cookie } });
		expect({ status: response.status, header: response.headers.get("x-route"), body: await response.text() }).toEqual({
			status: 200,
			header: method.toLowerCase(),
			body: "",
		});
	}
	expect(await (await app.post("/api/route-demo/value", {}, cookie)).json()).toEqual({
		method: "POST",
		params: { target: "value" },
	});
	expect((await get("/api/ext")).status).toBe(200);
	expect(await (await get("/api/ext")).json()).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "invalid.ts", status: "disabled", registrations: [] })]),
	);
	const openapi = await (await get("/api")).json();
	expect(openapi.paths["/api/route-demo/{name}"].get).toMatchObject({
		description: expect.stringContaining("zz-routes.ts"),
		parameters: [expect.objectContaining({ in: "path", name: "name", required: true })],
	});
	expect(openapi.paths["/api/route-demo/{id}"]).toBeUndefined();
	expect(openapi.paths["/api/route-demo/{target}"]).toBeUndefined();
	expect(openapi.paths["/api/route-demo/{name}"].post).toMatchObject({
		description: expect.stringContaining("Runtime pattern: /api/route-demo/:target."),
		parameters: [expect.objectContaining({ name: "name", in: "path" })],
	});
	expect(openapi.paths["/api/files/{bucket}/{*}"].get.parameters).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ in: "path", name: "bucket" }),
			expect.objectContaining({ in: "path", name: "*" }),
		]),
	);
	expect(await (await app.post("/api/files/docs/readme", {}, cookie)).json()).toEqual({
		container: "docs",
		file: "readme",
	});
	expect(openapi.paths["/api/files/{bucket}/{*}"].post.parameters).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "bucket" }), expect.objectContaining({ name: "*" })]),
	);
	expect(refusalSchema(openapi, openapi.paths["/api/route-demo/{name}"].get.responses[500])).toContain(
		"extension_disabled",
	);
	expect(refusalSchema(openapi, openapi.paths["/api/topics/{*}"].get.responses[500])).toContain("extension_disabled");
	const enrollment = await (await app.post("/auth/enroll", { name: "reader", kind: "agent", host: "test" })).json();
	const params = { id: enrollment.id, decision: "approve" as const, scopes: ["read"], long_lived: false };
	const proof = await app.assertion(params);
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", "x-chirp-assertion": proof },
				body: JSON.stringify({ decision: params.decision, scopes: params.scopes, long_lived: params.long_lived }),
			})
		).status,
	).toBe(200);
	const token = await (
		await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })
	).json();
	expect(
		(
			await fetch(`${app.url}/api/route-demo/value`, {
				method: "POST",
				headers: { authorization: `Bearer ${token.access}` },
				body: "{}",
			})
		).status,
	).toBe(403);
}, 25000);

it("keeps reserved and static core routes ahead of broad extension patterns", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "guard-seed");
	await mkdir(join(fixture.root, "pages"), { recursive: true });
	await cp(join(import.meta.dirname, "../pages/init.md"), join(fixture.root, "pages/init.md"));
	const onboarding = await readFile(join(fixture.root, "pages/init.md"), "utf8");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/broad.ts"),
		`export default api => {
 api.route("GET", "/:name", {description:"Broad single segment",scope:"read",handler:async()=>Response.json("extension")});
 api.route("GET", "/:section/ext", {description:"Broad extension path",scope:"read",handler:async()=>Response.json("extension")});
 api.route("GET", "/:section/ext/*", {description:"Broad nested extension path",scope:"read",handler:async()=>Response.json("extension")});
};`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(await (await fetch(`${app.url}/custom`, { headers: { cookie } })).json()).toBe("extension");
	expect(await (await fetch(`${app.url}/init`)).text()).toContain(onboarding);
	expect(await (await fetch(`${app.url}/in%69t`, { headers: { cookie } })).text()).toContain(onboarding);
	for (const path of ["/api/ext", "/api/%65xt", "/API/ext", "/api/ext/", "/api/ext;foo=bar"])
		expect(await (await fetch(`${app.url}${path}`, { headers: { cookie } })).json()).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "broad.ts", status: "loaded" })]),
		);
	expect((await fetch(`${app.url}/api`, { headers: { cookie } })).headers.get("content-type")).toContain(
		"application/json",
	);
	expect((await app.post("/api/messages", { topic: "retained", body: "keep me" }, cookie)).status).toBe(200);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const edited = await sourcePut(`${app.url}/api/fs/app/ext/zz-health.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: `export default api => api.route("GET", "/api/:endpoint", {description:"Broad parameter route",scope:"read",handler:async()=>Response.json({items:[]})});`,
	});
	expect(await edited.json()).toMatchObject({ status: "live" });
	expect(await (await fetch(`${app.url}/api/otherwise-unregistered`, { headers: { cookie } })).json()).toEqual({
		items: [],
	});
	expect(await (await fetch(`${app.url}/init`)).text()).toContain(onboarding);
	expect(await (await fetch(`${app.url}/api/ext`, { headers: { cookie } })).json()).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "zz-health.ts", status: "loaded" })]),
	);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic!='system'")).toEqual([{ body: "keep me" }]);
	expect(
		(await (await fetch(`${app.url}/api/messages?topic=retained&since=0`, { headers: { cookie } })).json()).items,
	).toEqual([expect.objectContaining({ body: "keep me" })]);
}, 25000);

it("isolates wildcard and parameter template conflicts during reload and retains healthy routes", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "retained", body: "keep me" }, cookie)).status).toBe(200);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = `export default api => {
 api.route("GET","/api/uncommitted-route",{description:"Must not survive failed registration",scope:"read",handler:()=>Response.json("bad")});
 api.route("GET","/api/topics/:path",{description:"Conflicting topic template",scope:"read",handler:()=>Response.json("bad")});
};`;
	const response = await sourcePut(`${app.url}/api/fs/app/ext/zz-template.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: source,
	});
	expect(await response.json()).toMatchObject({ status: "live" });
	const get = (path: string) => fetch(`${app.url}${path}`, { headers: { cookie } });
	expect(await (await get("/api/ext")).json()).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "core.ts", status: "loaded" }),
			expect.objectContaining({
				name: "zz-template.ts",
				status: "disabled",
				registrations: [],
				error: expect.stringContaining("core.ts"),
			}),
		]),
	);
	expect((await get("/api/uncommitted-route")).status).toBe(404);
	expect((await get("/api/topics/retained?mark=0")).status).toBe(200);
	expect((await get("/api")).status).toBe(200);
	await expect
		.poll(async () => (await (await get("/api/events?since=0&types=ext.failed")).json()).items)
		.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					payload: expect.objectContaining({ extension: "zz-template.ts", error: expect.stringContaining("core.ts") }),
				}),
			]),
		);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='retained'")).toEqual([{ body: "keep me" }]);
}, 25000);
