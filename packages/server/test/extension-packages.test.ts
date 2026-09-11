import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("loads packages in order, rejects a second core override atomically, and retains directory-scoped KV", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "package-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const route = (value: string) =>
		`export default api=>api.route("GET","/api/package-order",{description:"Package ordering",scope:"read",handler:async()=>Response.json(${JSON.stringify(value)})});`;
	const packageSource = async (name: string, source?: string) => {
		const directory = join(seed, "ext", name);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({ name: "ignored-manifest-name", main: "wrong.ts", exports: "./wrong.ts" }),
		);
		await writeFile(join(directory, "wrong.ts"), "throw Error('main must not load');");
		if (source !== undefined) await writeFile(join(directory, "index.ts"), source);
	};
	await writeFile(
		join(seed, "ext/core.ts"),
		`import {CoreApi} from "@comms/protocol";
import {coreHandlers} from "./core/api.ts";
export default api=>{api.mount(CoreApi,coreHandlers(api));api.route("GET","/api/package-order",{description:"Core package ordering",scope:"read",handler:async()=>Response.json("core file")});};`,
	);
	await writeFile(join(seed, "ext/a-first.ts"), route("first file"));
	await packageSource(
		"core",
		`export default api=>{
 api.route("GET","/api/conflict-partial",{description:"Must not leak",scope:"read",handler:async()=>Response.json("wrong")});
 api.route("GET","/api/package-order",{description:"Second core override",scope:"read",handler:async()=>Response.json("core directory")});
};`,
	);
	await packageSource("missing");
	await packageSource("broken", "invalid TypeScript !");
	await packageSource(
		"partial",
		'export default api=>{api.route("GET","/api/package-partial",{description:"Partial package",scope:"read",handler:async()=>Response.json("wrong")});throw Error("package factory failed")};',
	);
	await packageSource(
		"zz-package",
		`import {Effect} from "effect";
export default api=>{
 api.route("GET","/api/package-tail",{description:"Package tail",scope:"read",handler:async()=>Response.json("last package")});
 api.route("PUT","/api/package-kv",{description:"Save package scratch",scope:"write",handler:(_req,ctx)=>ctx.kv().set("saved",{value:"retained"}).pipe(Effect.as(Response.json("saved")))});
 api.route("GET","/api/package-kv",{description:"Read package scratch",scope:"read",handler:(_req,ctx)=>ctx.kv().get("saved").pipe(Effect.map(Response.json))});
};`,
	);
	await mkdir(join(seed, "ext/helpers.js"));
	await writeFile(join(seed, "ext/helpers.js/index.ts"), "throw Error('helper directory must not load');");
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string) => fetch(`${app.url}${path}`, { headers: { cookie } });
	expect(await (await get("/api/package-order")).json()).toBe("first file");
	expect(await (await get("/api/package-tail")).json()).toBe("last package");
	expect((await get("/api/conflict-partial")).status).toBe(404);
	expect((await get("/api/package-partial")).status).toBe(404);
	const statuses = await (await get("/api/ext")).json();
	expect(statuses.map((entry: { name: string }) => entry.name)).toEqual([
		"core.ts",
		"a-first.ts",
		"broken",
		"core",
		"missing",
		"partial",
		"standup.ts",
		"subscriptions",
		"system.ts",
		"zz-package",
	]);
	expect(statuses).toContainEqual(
		expect.objectContaining({
			name: "core",
			status: "disabled",
			registrations: [],
			error: expect.stringContaining("conflicts with a-first.ts"),
		}),
	);
	expect((await (await get("/api")).json()).paths["/api/package-order"].get.description).toContain("a-first.ts");
	for (const name of ["broken", "missing", "partial"])
		expect(statuses).toContainEqual(expect.objectContaining({ name, status: "disabled" }));
	expect((await get("/api/standup")).status).toBe(200);
	expect(
		(await fetch(`${app.url}/api/package-kv`, { method: "PUT", headers: { cookie, origin: "https://comms.test" } }))
			.status,
	).toBe(200);
	expect(await fixture.sql("SELECT ns,key FROM kv WHERE key='saved'")).toEqual([{ ns: "zz-package", key: "saved" }]);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const changed = await fetch(`${app.url}/api/fs/app/ext/core/index.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: route("changed core directory"),
	});
	expect(await changed.json()).toMatchObject({ status: "live" });
	expect(await (await get("/api/package-kv")).json()).toEqual({ value: "retained" });
	expect((await app.post("/api/messages", { topic: "packages", body: "still available" }, cookie)).status).toBe(200);
}, 35000);
