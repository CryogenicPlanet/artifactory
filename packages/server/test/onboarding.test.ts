import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("serves editable public orientation with negotiated HTML, a source version and verified instance context", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages"));
	await writeFile(join(fixture.root, "pages/init.md"), "---\nname: comms\n---\n# Welcome\n\nLive instructions.\n");
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
		["/_boot/metrics", "get", "fs"],
		["/_boot/restart", "post", "human"],
		["/_boot/reset", "post", "human"],
	] as const) {
		for (const paths of [manifest.endpoints, discovery.paths]) {
			expect(paths[path][method]["x-comms-auth"]).toBe(access);
			expect(paths[path][method].description.length).toBeGreaterThan(20);
			expect(paths[path][method]["x-comms-scopes"]).toEqual(access === "fs" ? ["fs"] : []);
		}
	}
	expect(discovery.paths["/_boot/seq"]).toBeUndefined();
	expect(discovery.paths["/_boot/revert"].post.description).toContain("generation.restore");
	expect(discovery.paths["/_boot/auth/challenge"].post.description).toContain("boot.restart");
	expect(discovery.paths["/_boot/auth/challenge"].post.description).toContain("app.reset");
	expect(discovery.paths["/_boot/reset"].post.description).toContain("preserves messages, pages and identities");

	const anonymous = await fetch(app.url + "/init", {
		headers: {
			"x-comms-agent": "spoofed",
			"x-comms-scopes": "read",
			"x-comms-instance": "spoofed",
			"x-comms-init": "0".repeat(64),
		},
	});
	expect(anonymous.status).toBe(200);
	expect(anonymous.headers.get("content-type")).toContain("text/markdown");
	const version = anonymous.headers.get("x-comms-init-version");
	expect(version).toMatch(/^[a-f0-9]{64}$/);
	expect(anonymous.headers.get("x-comms-init-stale")).toBe("1");
	const text = await anonymous.text();
	expect(text).toContain("Live instructions.");
	expect(text).toContain("GET /api/standup");
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
	expect((await app.post("/api/messages", { topic: "@rahul", body: "Hello" }, second)).status).toBe(200);
	const personal = await fetch(app.url + "/init", { headers: { cookie: first, "x-comms-init": version ?? "" } });
	expect(personal.headers.get("x-comms-init-stale")).toBeNull();
	expect(await personal.text()).toContain("You are <code>rahul@human</code>");
	const generations = await fixture.sql("SELECT n,status FROM generations", "boot.db");
	const edited = await fetch(app.url + "/api/fs/pages/init.md", {
		method: "PUT",
		headers: { cookie: first, origin: "https://comms.test" },
		body: "# Updated\n\nNew live instructions.\n",
	});
	expect(edited.status).toBe(200);
	const changed = await fetch(app.url + "/init.md", { headers: { "x-comms-init": version ?? "" } });
	expect(changed.headers.get("x-comms-init-stale")).toBe("1");
	expect(changed.headers.get("x-comms-init-version")).not.toBe(version);
	expect(await changed.text()).toContain("New live instructions.");
	expect(await fixture.sql("SELECT n,status FROM generations", "boot.db")).toEqual(generations);
	const beforeExtension = changed.headers.get("x-comms-init-version");
	expect((await app.post("/api/lock", {}, first)).status).toBe(200);
	const loaded = await fetch(app.url + "/api/fs/app/ext/orientation.ts", {
		method: "PUT",
		headers: { cookie: first, origin: "https://comms.test" },
		body: 'export default api => api.route("GET", "/api/orientation-example", {description:"Orientation example",scope:"read",handler:async()=>Response.json({ok:true})});',
	});
	expect(await loaded.json()).toMatchObject({ status: "live" });
	const registered = await fetch(app.url + "/init.md", { headers: { "x-comms-init": beforeExtension ?? "" } });
	expect(registered.headers.get("x-comms-init-stale")).toBeNull();
	expect(registered.headers.get("x-comms-init-version")).toBe(beforeExtension);
	expect(await registered.text()).toContain("GET /api/orientation-example");
	const updatedDiscovery = await (await fetch(app.url + "/api", { headers: { cookie: first } })).json();
	expect(updatedDiscovery.paths["/api/orientation-example"].get.description).toContain("Orientation example");
	expect(await (await fetch(app.url + "/.well-known/agent.json")).json()).toEqual(manifest);
	const head = await fetch(app.url + "/init", { method: "HEAD" });
	expect(head.status).toBe(200);
	expect(await head.text()).toBe("");
}, 30000);
