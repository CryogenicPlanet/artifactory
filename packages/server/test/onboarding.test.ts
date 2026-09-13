import {
	agentHeader,
	authExtension,
	initHeader,
	initStaleHeader,
	initVersionHeader,
	instanceHeader,
	scopesHeader,
} from "@comms/protocol/headers";
import { sourcePut } from "./fixtures/source-put.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("serves editable public orientation with negotiated HTML, a source version and verified instance context", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages"));
	await writeFile(join(fixture.root, "pages/init.md"), "---\nname: comms\n---\n# Welcome\n\nLive instructions.\n");
	await writeFile(
		join(fixture.root, "pages/quickstart.md"),
		"---\nname: chirp quickstart\n---\n# Quickstart\n\nNext steps after enrolling.\n",
	);
	const app = await fixture.launch();
	await app.setup();
	const first = await app.login(),
		second = await app.login();
	await app.ready(first);
	const manifest = await (await fetch(app.url + "/.well-known/agent.json")).json();
	const discovery = await (await fetch(app.url + "/api", { headers: { cookie: first } })).json();
	for (const [path, operations] of Object.entries(manifest.endpoints))
		expect(discovery.paths[path]).toEqual(operations);
	expect(discovery.components.securitySchemes).toMatchObject(manifest.components.securitySchemes);
	expect(manifest.endpoints["/api/messages"]).toBeUndefined();
	expect(manifest.endpoints["/_boot/metrics"]).toBeUndefined();
	expect(discovery.paths["/_boot/metrics"]).toBeUndefined();
	expect(manifest).toMatchObject({ api_url: "/api", recovery_url: "/_boot" });
	for (const path of ["/api", "/api/ext", "/init", "/init.md"]) {
		expect(discovery.paths[path].get.description.length).toBeGreaterThan(20);
		expect(Object.keys(discovery.paths[path])).toEqual(["get"]);
	}
	expect(Object.keys(discovery.paths["/init"].get.responses["200"].content).sort()).toEqual([
		"text/html",
		"text/markdown",
	]);
	expect(Object.keys(discovery.paths["/init.md"].get.responses["200"].content)).toEqual(["text/markdown"]);
	expect(discovery.paths["/api"].get.description).toContain("Requires read");
	expect(discovery.paths["/api/ext"].get.description).toContain("Requires read");
	for (const path of ["/init", "/init.md"]) expect(discovery.paths[path].get.description).toContain("Public");
	for (const [path, method, access] of [
		["/auth/enroll", "post", "public"],
		["/auth/enroll/{id}", "post", "device-secret"],
		["/auth/refresh", "post", "refresh-token"],
		["/api/fs/{path}", "put", "fs"],
		["/api/reload", "post", "fs"],
		["/_boot/db/backup", "post", "fs"],
		["/_boot/db/backups", "get", "human"],
		["/_boot/restart", "post", "human"],
		["/_boot/reset", "post", "human"],
	] as const) {
		for (const paths of [manifest.endpoints, discovery.paths]) {
			expect(paths[path][method][authExtension]).toBe(access);
			expect(paths[path][method].description.length).toBeGreaterThan(20);
			expect(paths[path][method][scopesHeader]).toEqual(access === "fs" ? ["fs"] : []);
		}
	}
	// A client generated from the app document must ship with credentials, not with "security": [].
	for (const [path, method, scope] of [
		["/api", "get", "read"],
		["/api/ext", "get", "read"],
		["/api/sql", "post", "read"],
		["/api/messages", "get", "read"],
		["/api/messages", "post", "write"],
		["/api/topics/{*}", "put", "write"],
		["/api/topics/{*}", "get", "read"],
		["/api/fs/{path}", "put", "fs"],
		["/api/lock", "post", "fs"],
		["/api/stream", "get", "read"],
		["/quickstart", "get", "read"],
	] as const) {
		expect(discovery.paths[path][method].security, `${method} ${path}`).toEqual([
			{ commsBootSession: [] },
			{ commsBootAccess: [] },
		]);
		expect(discovery.paths[path][method][scopesHeader], `${method} ${path}`).toEqual([scope]);
	}
	for (const path of ["/init", "/init.md"]) {
		expect(discovery.paths[path].get.security).toEqual([]);
		expect(discovery.paths[path].get[scopesHeader]).toEqual([]);
	}
	// The error union is declared on every operation; it is referenced once, never inlined again.
	const refusals = Object.entries(
		discovery.paths as Record<
			string,
			Record<
				string,
				{ readonly responses?: Record<string, { content?: Record<string, { schema?: Record<string, string> }> }> }
			>
		>,
	).flatMap(([path, item]) =>
		Object.entries(item).flatMap(([method, operation]) =>
			Object.entries(operation.responses ?? {})
				.filter(([status]) => Number(status) >= 400)
				.map(
					([status, response]) =>
						[`${method} ${path} ${status}`, response.content?.["application/json"]?.schema] as const,
				),
		),
	);
	expect(refusals.length).toBeGreaterThan(50);
	for (const [where, schema] of refusals) {
		expect(Object.keys(schema ?? {}), where).toEqual(["$ref"]);
		expect(discovery.components.schemas, where).toHaveProperty(
			(schema?.$ref ?? "").slice("#/components/schemas/".length),
		);
	}
	const schemes = Object.keys(discovery.components.securitySchemes);
	for (const item of Object.values(discovery.paths))
		for (const operation of Object.values(item as Record<string, { readonly security?: ReadonlyArray<object> }>))
			for (const requirement of operation.security ?? [])
				for (const name of Object.keys(requirement)) expect(schemes).toContain(name);
	expect(discovery.paths["/_boot/seq"]).toBeUndefined();
	expect(discovery.paths["/_boot/revert"].post.description).toContain("generation.restore");
	expect(discovery.paths["/_boot/auth/challenge"].post.description).toContain("boot.restart");
	expect(discovery.paths["/_boot/auth/challenge"].post.description).toContain("app.reset");
	expect(discovery.paths["/_boot/reset"].post.description).toContain("preserves messages, pages and identities");

	const anonymous = await fetch(app.url + "/init", {
		headers: {
			[agentHeader]: "spoofed",
			[scopesHeader]: "read",
			[instanceHeader]: "spoofed",
			[initHeader]: "0".repeat(64),
		},
	});
	expect(anonymous.status).toBe(200);
	expect(anonymous.headers.get("content-type")).toContain("text/markdown");
	const version = anonymous.headers.get(initVersionHeader);
	expect(version).toMatch(/^[a-f0-9]{64}$/);
	expect(anonymous.headers.get(initStaleHeader)).toBe("1");
	const text = await anonymous.text();
	expect(text).toContain("Live instructions.");
	expect(text).toContain("GET /api/standup");
	// The prose instructs agents to lock, stage and reload; the table must list those routes too.
	for (const route of ["POST /api/lock", "GET / PUT /api/fs/{path}", "POST /api/reload", "GET /_boot/events"])
		expect(text).toContain(route);
	expect(text).toContain(`Version ${version}`);
	expect(text).not.toContain("You are");
	expect(text).not.toContain("spoofed");
	const html = await fetch(app.url + "/init", { headers: { accept: "text/html" } });
	expect(html.headers.get("content-type")).toContain("text/html");
	const document = await html.text();
	expect(document).toContain("<h1>Welcome</h1>");
	expect(document).not.toContain("name: comms");
	expect(document).toContain('href="/init.md"');
	const raw = await fetch(app.url + "/init.md", { headers: { accept: "text/html" } });
	expect(raw.headers.get("content-type")).toContain("text/markdown");
	expect(await raw.text()).toContain("name: comms");
	expect((await fetch(app.url + "/p/init.md")).status).toBe(401);
	// The guides it links need a token, so the page that links them is authenticated too.
	expect((await fetch(app.url + "/quickstart")).status).toBe(401);
	const guided = await fetch(app.url + "/quickstart", { headers: { cookie: first } });
	expect(guided.status).toBe(200);
	expect(guided.headers.get("content-type")).toContain("text/markdown");
	const guide = await guided.text();
	expect(guide).toContain("Next steps after enrolling.");
	expect(guide).toContain("You are <code>rahul@human</code>");
	const guidedHtml = await fetch(app.url + "/quickstart", { headers: { cookie: first, accept: "text/html" } });
	expect(guidedHtml.headers.get("content-type")).toContain("text/html");
	const guidedDocument = await guidedHtml.text();
	expect(guidedDocument).toContain("<h1>Quickstart</h1>");
	expect(guidedDocument).not.toContain("name: chirp quickstart");
	const guidedRaw = await fetch(app.url + "/quickstart.md", { headers: { cookie: first, accept: "text/html" } });
	expect(guidedRaw.headers.get("content-type")).toContain("text/markdown");
	expect(await guidedRaw.text()).toContain("name: chirp quickstart");
	expect((await app.post("/api/messages", { topic: "@rahul", body: "Hello" }, second)).status).toBe(200);
	const personal = await fetch(app.url + "/init", { headers: { cookie: first, [initHeader]: version ?? "" } });
	expect(personal.headers.get(initStaleHeader)).toBeNull();
	expect(await personal.text()).toContain("You are <code>rahul@human</code>");
	const generations = await fixture.sql("SELECT n,status FROM generations", "boot.db");
	const edited = await sourcePut(app.url + "/api/fs/pages/init.md", {
		method: "PUT",
		headers: { cookie: first, origin: "https://comms.test" },
		body: "# Updated\n\nNew live instructions.\n",
	});
	expect(edited.status).toBe(200);
	const changed = await fetch(app.url + "/init.md", { headers: { [initHeader]: version ?? "" } });
	expect(changed.headers.get(initStaleHeader)).toBe("1");
	expect(changed.headers.get(initVersionHeader)).not.toBe(version);
	expect(await changed.text()).toContain("New live instructions.");
	expect(await fixture.sql("SELECT n,status FROM generations", "boot.db")).toEqual(generations);
	const beforeExtension = changed.headers.get(initVersionHeader);
	expect((await app.post("/api/lock", {}, first)).status).toBe(200);
	const loaded = await sourcePut(app.url + "/api/fs/app/ext/orientation.ts", {
		method: "PUT",
		headers: { cookie: first, origin: "https://comms.test" },
		body: 'export default api => api.route("GET", "/api/orientation-example", {description:"Orientation example",scope:"read",handler:async()=>Response.json({ok:true})});',
	});
	expect(await loaded.json()).toMatchObject({ status: "live" });
	const registered = await fetch(app.url + "/init.md", { headers: { [initHeader]: beforeExtension ?? "" } });
	expect(registered.headers.get(initStaleHeader)).toBeNull();
	expect(registered.headers.get(initVersionHeader)).toBe(beforeExtension);
	expect(await registered.text()).toContain("GET /api/orientation-example");
	const updatedDiscovery = await (await fetch(app.url + "/api", { headers: { cookie: first } })).json();
	expect(updatedDiscovery.paths["/api/orientation-example"].get.description).toContain("Orientation example");
	expect(await (await fetch(app.url + "/.well-known/agent.json")).json()).toEqual(manifest);
	const head = await fetch(app.url + "/init", { method: "HEAD" });
	expect(head.status).toBe(200);
	expect(await head.text()).toBe("");
}, 30000);

it("ships onboarding text that matches the live mention, mark and page-access rules", async () => {
	const pages = join(import.meta.dirname, "../pages");
	const init = await readFile(join(pages, "init.md"), "utf8");
	// mentions=@codex alone never matches @codex/job-17, so the first example must name both.
	expect(init).toContain("mentions=@codex,@codex/job-17,@here");
	expect(init).not.toContain("mentions=@codex,@here");
	expect(init).toContain("never advances a read mark");
	expect(init).toContain("/quickstart");
	expect(init).toMatch(/`\/p\/docs\/\.\.\.` link below needs your access token/);
	const quickstart = await readFile(join(pages, "quickstart.md"), "utf8");
	for (const guide of ["recipes.md", "stream.md", "subscriptions.md", "extensions.md", "editing.md"])
		expect(quickstart).toContain(`/p/docs/${guide}`);
});
