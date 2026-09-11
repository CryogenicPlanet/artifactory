import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";
const execute = promisify(execFile);

it("loads optional extensions independently with described overrides and verified request identity", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const route = (body: string, core = false) =>
		`import {CoreApi} from "@comms/protocol";
import {coreHandlers} from "./core/api.ts";
export default api => {${core ? "api.mount(CoreApi,coreHandlers(api));" : ""}api.route("GET", "/api/example", {description:"Example override",scope:"read",handler:async (req,ctx)=>Response.json(${body})});};`;
	await writeFile(join(seed, "ext/core.ts"), route('"core"', true));
	await writeFile(
		join(seed, "ext/zz-example.ts"),
		route("{agent:ctx.agent,instance:ctx.instance,headers:Object.fromEntries(req.source.headers)}"),
	);
	await writeFile(join(seed, "ext/broken.ts"), "invalid TypeScript !");
	await writeFile(
		join(seed, "ext/partial.ts"),
		'export default api => {api.route("GET","/api/partial",{description:"Partial registration",scope:"read",handler:async()=>Response.json("unexpected")});throw Error("factory failed");}',
	);
	await writeFile(
		join(seed, "ext/throws.ts"),
		'export default api => api.route("GET","/api/throws",{description:"Throwing handler",scope:"read",handler:async()=>{throw Error("handler failed")}});',
	);
	await writeFile(
		join(seed, "ext/reserved.ts"),
		'export default api=>api.route("GET","/api/events",{description:"Invalid override",scope:"read",handler:async()=>Response.json({})});',
	);
	await writeFile(
		join(seed, "ext/head.ts"),
		'export default api=>{api.route("GET","/api/head",{description:"Get",scope:"read",handler:async()=>new Response("get")});api.route("HEAD","/api/head",{description:"Head",scope:"read",handler:async()=>new Response(null,{headers:{"x-head":"explicit"}})});}',
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string) =>
		fetch(`${app.url}${path}`, { headers: { cookie, "x-comms-agent": "spoof", "x-comms-instance": "spoof" } });
	expect((await fetch(`${app.url}/api/example`)).status).toBe(401);
	const identity = await (await get("/api/example")).json();
	expect(identity).toMatchObject({ agent: "rahul" });
	expect(identity.instance).not.toBe("spoof");
	for (const secret of ["x-boot-secret", "authorization", "cookie"]) expect(identity.headers[secret]).toBeUndefined();
	expect((await get("/api/partial")).status).toBe(404);
	for (let attempt = 0; attempt < 2; attempt++) {
		const disabled = await get("/api/throws");
		expect(disabled.status).toBe(500);
		expect(await disabled.json()).toMatchObject({ error: { code: "extension_disabled", retriable: false } });
	}
	expect((await get("/api/standup")).status).toBe(200);
	expect((await fetch(`${app.url}/api/head`, { method: "HEAD", headers: { cookie } })).headers.get("x-head")).toBe(
		"explicit",
	);
	const statuses = await (await get("/api/ext")).json();
	expect(statuses).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "broken.ts", status: "disabled", registrations: [] }),
			expect.objectContaining({
				name: "partial.ts",
				status: "disabled",
				error: expect.stringContaining("factory failed"),
			}),
			expect.objectContaining({
				name: "throws.ts",
				status: "disabled",
				error: expect.stringContaining("handler failed"),
			}),
			expect.objectContaining({ name: "zz-example.ts", status: "loaded" }),
			expect.objectContaining({ name: "reserved.ts", status: "disabled", registrations: [] }),
		]),
	);
	expect((await (await get("/api")).json()).paths["/api/example"].get.description).toContain("zz-example.ts");
	expect((await (await fetch(`${app.url}/.well-known/agent.json`)).json()).endpoints["/api/example"]).toBeDefined();
	await expect
		.poll(async () =>
			(await (await get("/api/events?since=0&types=ext.*")).json()).items.map((event: { type: string }) => event.type),
		)
		.toEqual(expect.arrayContaining(["ext.loaded", "ext.failed", "ext.error"]));
	expect((await app.post("/api/messages", { topic: "independent", body: "still working" }, cookie)).status).toBe(200);
}, 25000);

it("rejects a broken core override through actual health, but accepts an unrelated broken optional extension", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "lifecycle-seed"),
		record = join(fixture.root, "lifecycle.jsonl");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/lifecycle.ts"),
		`import {Config,Effect,FileSystem} from "effect";
 export default api=>Effect.gen(function*(){const fs=yield* FileSystem.FileSystem;const generation=yield* Config.Int("GENERATION");const log=type=>fs.writeFileString(${JSON.stringify(record)},JSON.stringify({type,generation})+"\\n",{flag:"a"});api.on("start",()=>log("start"));api.on("shutdown",()=>log("stop"));});`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "retained", body: "acknowledged" }, cookie)).status).toBe(200);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const put = (body: string) =>
		fetch(`${app.url}/api/fs/app/ext/zz-override.ts`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test" },
			body,
		});
	const broken =
		'export default api => api.route("GET","/api/messages",{description:"Broken core override",scope:"read",handler:async()=>Response.json({items:[]})});';
	expect(await (await put(broken)).json()).toMatchObject({ status: "failed" });
	expect(
		(await (await fetch(`${app.url}/api/messages?topic=retained&since=0`, { headers: { cookie } })).json()).items,
	).toEqual([expect.objectContaining({ body: "acknowledged" })]);
	expect(await (await put("invalid optional TypeScript !")).json()).toMatchObject({ status: "live" });
	expect(await (await fetch(`${app.url}/api/ext`, { headers: { cookie } })).json()).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "zz-override.ts", status: "disabled" })]),
	);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic!='system'")).toEqual([{ body: "acknowledged" }]);
	const trace = (await readFile(record, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(trace.map((event) => event.type)).toEqual(["start", "start", "stop", "start", "stop", "stop", "start"]);
	expect(trace[0].generation).toBe(trace[5].generation);
	expect(trace[6].generation).not.toBe(trace[0].generation);
	const events = await (await fetch(`${app.url}/api/events?since=0&types=ext.*`, { headers: { cookie } })).json();
	expect(
		events.items.every(
			(event: { payload: { error?: string } }) => !event.payload.error?.includes("Broken core override"),
		),
	).toBe(true);
}, 35000);

it("owns live hooks, isolates failed resource cleanup, and recreates healthy scopes after a canceled freeze", async (test) => {
	const fixture = await conversation(test);
	const directory = join(fixture.root, "extensions");
	await mkdir(directory);
	await symlink(join(import.meta.dirname, "../node_modules"), join(directory, "node_modules"));
	const record = join(directory, "record.txt");
	const cleanupRecord = join(directory, "cleanup.txt");
	await writeFile(
		join(directory, "a-cleanup.ts"),
		`import {Effect,FileSystem} from "effect";
export default api => Effect.gen(function*(){
 const fs=yield* FileSystem.FileSystem;
 api.on("start",()=>Effect.gen(function*(){
  yield* fs.writeFileString(${JSON.stringify(cleanupRecord)},"start,",{flag:"a"});
  yield* Effect.addFinalizer(()=>Effect.die("cleanup exploded"));
 }));
});`,
	);
	await mkdir(join(directory, "scoped"));
	await writeFile(join(directory, "scoped/package.json"), "{}");
	await writeFile(
		join(directory, "scoped/index.ts"),
		`import {Effect,FileSystem} from "effect";
export default api => Effect.gen(function*(){
 const fs=yield* FileSystem.FileSystem;
 const write=text=>fs.writeFileString(${JSON.stringify(record)},text,{flag:"a"});
 api.on("start",()=>Effect.gen(function*(){yield* write("start,");yield* Effect.addFinalizer(()=>write("closing,").pipe(Effect.andThen(Effect.sleep("100 millis")),Effect.andThen(write("close,")),Effect.orDie));}));
 api.on("shutdown",()=>write("shutdown,"));
 api.route("GET","/api/failure",{description:"Fail while closing",scope:"read",handler:()=>Effect.die("route failure")});
});`,
	);
	const { stdout } = await execute("bun", [join(import.meta.dirname, "fixtures/extension-lifecycle.ts")], {
		env: { ...process.env, EXTENSION_DIRECTORY: directory },
	});
	const result = JSON.parse(stdout);
	expect(result.trace).toEqual([
		"",
		"",
		"",
		"start,",
		"start,",
		"start,closing,close,shutdown,",
		"start,closing,close,shutdown,start,",
		"start,closing,close,shutdown,start,closing,close,shutdown,",
		"start,closing,close,shutdown,start,closing,close,shutdown,start,closing,close,shutdown,",
	]);
	expect(await readFile(cleanupRecord, "utf8")).toBe("start,");
	expect(result.status).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: "a-cleanup.ts",
				status: "disabled",
				error: expect.stringContaining("cleanup exploded"),
			}),
		]),
	);
	expect(result.diagnostics.filter((entry: { type: string }) => entry.type === "ext.error")).toEqual([
		expect.objectContaining({
			payload: { extension: "a-cleanup.ts", error: expect.stringContaining("cleanup exploded") },
		}),
		expect.objectContaining({ payload: { extension: "scoped", error: expect.stringContaining("route failure") } }),
	]);
});

it("loads separately built core and standup extensions from a bundled seed", async (test) => {
	const fixture = await conversation(test),
		seed = join(fixture.root, "built");
	await execute("bun", [
		"build",
		join(import.meta.dirname, "../src/server.ts"),
		"--target=bun",
		"--packages=external",
		`--outdir=${seed}`,
	]);
	await execute("bun", [
		"build",
		join(import.meta.dirname, "../src/ext/core.ts"),
		join(import.meta.dirname, "../src/ext/standup.ts"),
		"--target=bun",
		"--packages=external",
		`--outdir=${join(seed, "ext")}`,
	]);
	const app = await fixture.launch(join(seed, "server.js"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "bundled", body: "built extension" }, cookie)).status).toBe(200);
	expect(await (await fetch(`${app.url}/api/standup`, { headers: { cookie } })).json()).toEqual([
		{ agent: "rahul", messages: 1 },
	]);
	expect(await (await fetch(`${app.url}/api/ext`, { headers: { cookie } })).json()).toEqual([
		expect.objectContaining({ name: "core.js", status: "loaded" }),
		expect.objectContaining({ name: "standup.js", status: "loaded" }),
	]);
}, 20000);
