import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("serves a compiled board with a public onboarding shell from its generation and confines SPA fallback and assets", async (test) => {
	const fixture = await conversation(test),
		seed = join(fixture.root, "built");
	await promisify(execFile)("bun", [
		"build",
		join(import.meta.dirname, "../src/server.ts"),
		"--target=bun",
		"--packages=external",
		`--outdir=${seed}`,
	]);
	await promisify(execFile)("bun", [
		"build",
		join(import.meta.dirname, "../src/ext/core.ts"),
		"--target=bun",
		"--packages=external",
		`--outdir=${join(seed, "ext")}`,
	]);
	await mkdir(join(seed, "board/assets"), { recursive: true });
	const html = '<!doctype html><title>Snapshot board</title><script src="/assets/board.js"></script>';
	await writeFile(join(seed, "board/index.html"), html);
	await writeFile(join(seed, "board/assets/style.css"), "body { color: white; }");
	await writeFile(join(seed, "board/assets/board.js"), 'document.title="Compiled board";');
	const app = await fixture.launch(join(seed, "server.js"));
	const first = await fetch(`${app.url}/`, { headers: { accept: "text/html" }, redirect: "follow" });
	await expect.poll(async () => (await fetch(`${app.url}/onboarding`)).status).toBe(200);
	expect(await (await fetch(`${app.url}/onboarding`)).text()).toBe(html);
	expect(first.url).toContain("/onboarding");
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string, method = "GET") => fetch(`${app.url}${path}`, { method, headers: { cookie } });
	for (const path of ["/", "/t/project/thread", "/ext", "/@rahul", "/_boot/recovery"])
		expect((await fetch(`${app.url}${path}`)).status).toBe(401);
	for (const path of ["/onboarding", "/assets/board.js", "/assets/style.css"]) {
		const publicResponse = await fetch(`${app.url}${path}`);
		expect(publicResponse.status).toBe(200);
		expect(publicResponse.headers.get("cache-control")).toBe("no-store");
		expect((await fetch(`${app.url}${path}`, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
	}
	for (const path of ["/onboarding/other", "/assets/other.js", "/api/messages", "/api/sql", "/t/private"])
		expect((await fetch(`${app.url}${path}`)).status).toBe(401);
	expect((await fetch(`${app.url}/onboarding`, { method: "POST" })).status).toBe(401);
	for (const path of ["/", "/t/project/thread", "/ext", "/@rahul"]) {
		const response = await get(path);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("content-security-policy")).toBe(
			"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'",
		);
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await response.text()).toBe(html);
	}
	const recovery = await get("/_boot/recovery");
	expect(recovery.status).toBe(200);
	expect(recovery.headers.get("cache-control")).toBe("no-store");
	expect(await recovery.text()).toContain("Recover app source");
	expect((await get("/_boot/recovery?x=1")).status).toBe(400);
	expect((await get("/_boot/recovery", "POST")).status).toBe(405);
	const javascript = await get("/assets/board.js");
	expect(javascript.headers.get("content-type")).toContain("javascript");
	expect(javascript.headers.get("x-content-type-options")).toBe("nosniff");
	expect(await javascript.text()).toContain("Compiled board");
	expect(await (await get("/", "HEAD")).text()).toBe("");
	for (const path of [
		"/assets/missing.js",
		"/assets/%2e%2e%2fserver.js",
		"/assets/%5cserver.js",
		"/assets/%00.js",
		"/assets/%ZZ",
		"/server.js",
		"/api/unknown",
		"/random",
	])
		expect((await get(path)).status).toBe(404);
	await writeFile(join(fixture.root, "app/board/index.html"), "edited outside snapshot");
	expect(await (await get("/")).text()).toBe(html);
	const generations = await (await get("/api/generations")).json();
	const generation = generations.last_good;
	const board = join(fixture.root, "gen", String(generation), "source/board");
	await symlink(join(seed, "server.js"), join(board, "assets/escape.js"));
	expect((await get("/assets/escape.js")).status).toBe(404);
	expect(await readFile(join(board, "index.html"), "utf8")).toBe(html);
	await rm(join(board, "index.html"));
	const fallback = await get("/");
	expect(fallback.status).toBe(503);
	expect(fallback.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
	expect(fallback.headers.get("content-security-policy")).toContain("form-action 'self'");
	expect(await fallback.text()).toContain("open recovery help");
	expect((await get("/api/messages?since=0")).status).toBe(200);
	await app.stop();
	const preparedBoard = join(fixture.root, "gen", String(generation), "source.board");
	await mkdir(preparedBoard);
	await writeFile(join(preparedBoard, "index.html"), "<title>Prepared sibling board</title>");
	const resumed = await fixture.launch(join(seed, "server.js"));
	await resumed.ready(cookie);
	expect(await (await fetch(`${resumed.url}/`, { headers: { cookie } })).text()).toBe(
		"<title>Prepared sibling board</title>",
	);
	expect(await readFile(join(fixture.root, "app/board/index.html"), "utf8")).toBe("edited outside snapshot");
}, 20000);
