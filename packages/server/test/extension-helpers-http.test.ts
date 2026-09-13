import { assertionHeader } from "@comms/protocol/headers";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("serves human-only extension pages and preserves isolated scratch data and attributed logs across restart", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/dashboard.ts"),
		`import {Effect} from "effect";
 export default api => {
  api.page("/dashboard",ctx=>Effect.gen(function*(){const value=yield* ctx.kv().get("greeting");return "<!doctype html><h1>"+String(value ?? "empty")+"</h1>";}));
  api.route("GET","/api/dashboard",{description:"Read dashboard scratch",scope:"read",handler:(_req,ctx)=>Effect.map(ctx.kv().get(ctx.query.key),value=>Response.json(value))});
  api.route("POST","/api/dashboard",{description:"Save greeting",scope:"write",handler:(_req,ctx)=>Effect.gen(function*(){yield* ctx.kv().set("greeting","hello");yield* ctx.log("dashboard.saved",{ok:true});return Response.json({saved:true});})});
 }`,
	);
	await writeFile(
		join(seed, "ext/other.ts"),
		`import {Effect} from "effect";
 export default api => api.page("/other",ctx=>Effect.map(ctx.kv().get("greeting"),value=>String(value)));`,
	);
	let app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	let cookie = await app.login();
	await app.ready(cookie);
	expect((await fetch(app.url + "/dashboard")).status).toBe(401);
	expect((await app.post("/api/dashboard", {}, cookie)).status).toBe(200);
	expect((await fetch(app.url + "/api/dashboard?key=" + "x".repeat(201), { headers: { cookie } })).status).toBe(400);
	const page = await fetch(app.url + "/dashboard", { headers: { cookie } });
	expect(page.status).toBe(200);
	expect(page.headers.get("content-type")).toContain("text/html");
	expect(page.headers.get("cache-control")).toBe("no-store");
	expect(await page.text()).toContain("<h1>hello</h1>");
	expect(await (await fetch(app.url + "/other", { headers: { cookie } })).text()).toBe("null");
	const enrollment = await (
		await app.post("/auth/enroll", { name: "helper-reader", kind: "codex", host: "test" })
	).json();
	const params = { id: enrollment.id, decision: "approve" as const, scopes: ["read"], long_lived: false };
	const assertion = await app.assertion(params);
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", [assertionHeader]: assertion },
				body: JSON.stringify({ decision: params.decision, scopes: params.scopes, long_lived: params.long_lived }),
			})
		).status,
	).toBe(200);
	const pair = await (
		await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })
	).json();
	expect((await fetch(app.url + "/dashboard", { headers: { authorization: `Bearer ${pair.access}` } })).status).toBe(
		403,
	);
	const events = await (
		await fetch(app.url + "/api/events?since=0&types=dashboard.saved", { headers: { cookie } })
	).json();
	expect(events.items).toEqual([
		expect.objectContaining({ actor: "rahul", payload: { ok: true, extension: "dashboard.ts" } }),
	]);
	await app.stop();
	app = await fixture.launch(join(seed, "server.ts"));
	cookie = await app.login();
	await app.ready(cookie);
	expect(await (await fetch(app.url + "/dashboard", { headers: { cookie } })).text()).toContain("<h1>hello</h1>");
}, 30000);
