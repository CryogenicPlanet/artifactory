import { sourcePut } from "./fixtures/source-put.ts";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";
import { pagePublicationQueue } from "./fixtures/page-publication-queue.ts";

it("serves private Markdown with raw links, highlighting, conditional diagrams and explicit Tailwind", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages", "guide"), { recursive: true });
	const markdown =
		"# Guide\n\n| Language | Ready |\n| --- | --- |\n| TS | yes |\n\n```typescript\nconst answer = 42;\n```\n\n[asset](asset.txt)\n";
	await writeFile(join(fixture.root, "pages", "guide", "index.md"), markdown);
	await writeFile(join(fixture.root, "pages", "guide", "index.html"), "html loses to markdown");
	await writeFile(
		join(fixture.root, "pages", "guide", "diagram.md"),
		"# Diagram\n\n```mermaid\ngraph TD; A-->B;\n```\n",
	);
	await writeFile(join(fixture.root, "pages", "guide", "styled.md"), "<!-- tailwind -->\n# Styled\n");
	await writeFile(join(fixture.root, "pages", "guide", "frontmatter.md"), "---\ntailwind: true\n---\n# Styled\n");
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await fetch(app.url + "/p/guide/")).status).toBe(401);
	const get = (path: string, method = "GET") => fetch(app.url + path, { method, headers: { cookie } });
	const response = await get("/p/guide/");
	expect(response.status).toBe(200);
	expect(response.headers.get("content-security-policy")).toBe(
		"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
	);
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	const body = await response.text();
	expect(body).toContain("<h1>Guide</h1>");
	expect(body).toContain("<table>");
	expect(body).toContain("hljs-keyword");
	expect(body).toContain("/p/guide/index.md?raw=1");
	expect(body).toContain('href="asset.txt"');
	expect(body).not.toContain("/page-assets/mermaid");
	expect(body).not.toContain("/page-assets/tailwind.js");
	expect(body).not.toContain("https://cdn");
	expect(await (await get("/p/guide/?raw=1")).text()).toBe(markdown);
	expect(await (await get("/p/guide/diagram.md")).text()).toContain("/page-assets/mermaid-init.js");
	expect(await (await get("/p/guide/styled.md")).text()).toContain('@import "tailwindcss/utilities"');
	const frontmatter = await (await get("/p/guide/frontmatter.md")).text();
	expect(frontmatter).toContain('@import "tailwindcss/utilities"');
	expect(frontmatter).not.toContain("tailwind: true");
	expect(frontmatter).not.toContain("tailwindcss/preflight");
	for (const name of ["markdown.css", "highlight.css", "mermaid.js", "mermaid-init.js", "tailwind.js"]) {
		const asset = await fetch(app.url + `/page-assets/${name}`);
		expect(asset.status, name).toBe(200);
		expect(asset.headers.get("content-type")).toContain(name.endsWith(".css") ? "text/css" : "text/javascript");
		expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
		expect((await asset.text()).length).toBeGreaterThan(50);
	}
	expect((await get("/page-assets/package.json")).status).toBe(404);
	expect((await fetch(app.url + "/page-assets/package.json")).status).toBe(401);
	expect((await fetch(app.url + "/page-assets/mermaid.js", { method: "POST" })).status).toBe(401);
	expect(
		(await fetch(app.url + "/page-assets/mermaid.js", { headers: { authorization: "Bearer invalid" } })).status,
	).toBe(401);
	const assetHead = await fetch(app.url + "/page-assets/mermaid.js", { method: "HEAD" });
	expect(assetHead.status).toBe(200);
	expect(await assetHead.text()).toBe("");
	const head = await get("/p/guide/", "HEAD");
	expect(head.status).toBe(200);
	expect(head.headers.get("content-security-policy")).toBe(response.headers.get("content-security-policy"));
	expect(head.headers.get("content-type")).toContain("text/html");
	expect(await head.text()).toBe("");
}, 20000);

it("preserves HTML and binary bytes, redirects directory bases and lists escaped filenames", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages", "tooling"), { recursive: true });
	await mkdir(join(fixture.root, "pages", "plain"));
	const html = "<!doctype html><html><body><script>const trusted = true;</script>tooling</body></html>";
	const binary = Buffer.from([0, 255, 3, 7, 0, 128]);
	await writeFile(join(fixture.root, "pages", "tooling", "index.html"), html);
	await writeFile(join(fixture.root, "pages", "plain", 'a"<b>.bin'), binary);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string) => fetch(app.url + path, { headers: { cookie } });
	const redirect = await fetch(app.url + "/p/tooling?raw=1", { headers: { cookie }, redirect: "manual" });
	expect(redirect.status).toBe(302);
	expect(redirect.headers.get("location")).toBe("/p/tooling/?raw=1");
	const htmlResponse = await get("/p/tooling/");
	expect(htmlResponse.headers.get("content-type")).toContain("text/html");
	expect(await htmlResponse.text()).toBe(html);
	expect(htmlResponse.headers.get("content-security-policy")).toContain("script-src 'self'");
	expect(htmlResponse.headers.get("referrer-policy")).toBe("no-referrer");
	const listingResponse = await get("/p/plain/");
	expect(listingResponse.headers.get("content-security-policy")).toBe(
		htmlResponse.headers.get("content-security-policy"),
	);
	const listing = await listingResponse.text();
	expect(listing).toContain("a&quot;&lt;b&gt;.bin");
	const asset = await get("/p/plain/" + encodeURIComponent('a"<b>.bin'));
	expect(Buffer.from(await asset.arrayBuffer())).toEqual(binary);
	expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
	const head = await fetch(app.url + "/p/plain/" + encodeURIComponent('a"<b>.bin'), {
		method: "HEAD",
		headers: { cookie },
	});
	expect(head.headers.get("content-length")).toBe(String(binary.length));
	expect(await head.text()).toBe("");
}, 20000);

it("serves text files with unknown or misleading extensions inline as plain text", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages", "plain"), { recursive: true });
	const source = "export const answer = 42;\n";
	await writeFile(join(fixture.root, "pages", "plain", "evlog-sink.ts"), source);
	await writeFile(join(fixture.root, "pages", "plain", "notes"), "no extension\n");
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const script = await fetch(app.url + "/p/plain/evlog-sink.ts", { headers: { cookie } });
	expect(script.status).toBe(200);
	expect(script.headers.get("content-type")).toContain("text/");
	expect(await script.text()).toBe(source);
	const notes = await fetch(app.url + "/p/plain/notes", { headers: { cookie } });
	expect(notes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
	expect(await notes.text()).toBe("no extension\n");
}, 20000);

it("rejects symlink and traversal reads and hides publishing temporaries from page listings", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages", "safe"), { recursive: true });
	await writeFile(join(fixture.root, "secret.txt"), "outside secret");
	await writeFile(join(fixture.root, "pages", "safe", "normal.md"), "safe");
	await writeFile(join(fixture.root, "pages", "safe", ".comms-test.tmp"), "unpublished");
	await symlink(join(fixture.root, "secret.txt"), join(fixture.root, "pages", "safe", "linked.txt"));
	await symlink(join(fixture.root, "pages", "safe"), join(fixture.root, "pages", "alias"));
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	for (const path of [
		"/p/safe/linked.txt",
		"/p/alias/normal.md",
		"/p/safe%2f..%2f..%2fsecret.txt",
		"/p/safe/.comms-test.tmp",
		"/p/safe/a%5cb",
	]) {
		const response = await fetch(app.url + path, { headers: { cookie } });
		expect(response.status, path).toBe(400);
		expect(await response.text()).not.toContain("outside secret");
	}
	const listing = await (await fetch(app.url + "/p/safe/", { headers: { cookie } })).text();
	expect(listing).not.toContain("linked.txt");
	expect(listing).not.toContain(".comms-");
	expect((await fetch(app.url + "/p/missing", { headers: { cookie } })).status).toBe(404);
}, 20000);

it("merges page-only topic directories without manufacturing messages or changing unread and respects archived ancestry", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages", "project", "reference", "deep"), { recursive: true });
	await mkdir(join(fixture.root, "pages", "only-pages"), { recursive: true });
	await writeFile(join(fixture.root, "pages", "project", "index.md"), "# Project README");
	await writeFile(join(fixture.root, "pages", "project", "reference", "guide.md"), "guide");
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "project/conversation", body: "hello" }, cookie)).status).toBe(200);
	const get = async (path: string) => (await fetch(app.url + path, { headers: { cookie } })).json();
	const root = await get("/api/topics?mark=0");
	expect(root.unread - (root.subtopics.find((row: { path: string }) => row.path === "system")?.unread ?? 0)).toBe(1);
	expect(root.messages.filter((row: { topic: string }) => row.topic !== "system")).toHaveLength(1);
	expect(root.subtopics.map((row: { path: string }) => row.path).filter((path: string) => path !== "system")).toEqual([
		"project",
		"only-pages",
	]);
	expect(await get("/api/topics/only-pages")).toMatchObject({
		meta: {},
		unread: 0,
		messages: [],
		pages: [],
		index: null,
	});
	const topic = await get("/api/topics/project?mark=0");
	expect(topic).toMatchObject({ index: "# Project README", pages: ["index.md"], unread: 1 });
	expect(topic.subtopics.map((row: { path: string }) => row.path)).toEqual([
		"project/conversation",
		"project/reference",
	]);
	expect((await get("/api/topics/project?depth=2")).subtopics).toHaveLength(3);
	expect(await fixture.sql("SELECT path FROM topics WHERE path<>'system' ORDER BY path")).toEqual([
		{ path: "project" },
		{ path: "project/conversation" },
	]);
	await fixture.sql("UPDATE topics SET archived_at=1 WHERE path='project'");
	expect(
		(await get("/api/topics")).subtopics
			.map((row: { path: string }) => row.path)
			.filter((path: string) => path !== "system"),
	).toEqual(["only-pages"]);
	expect((await get("/api/topics/project")).subtopics).toEqual([]);
	expect((await get("/api/topics/project?archived=1")).subtopics).toHaveLength(2);
	expect((await get("/api/topics/project/reference")).pages).toEqual(["guide.md"]);
}, 20000);

it("hides deleted page ancestry at the published fence while retaining raw filesystem repair", async (test) => {
	const fixture = await pagePublicationQueue(test);
	for (const topic of ["gone", "gone/page-only", "gone/deep", "gone-other"]) {
		await mkdir(join(fixture.root, "pages", topic), { recursive: true });
		await writeFile(join(fixture.root, "pages", topic, "readme.md"), `# ${topic}`);
		await writeFile(join(fixture.root, "pages", topic, "asset.bin"), Buffer.from([1, 2, 3]));
	}
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	for (const topic of ["gone", "gone/deep", "gone-other"])
		expect((await app.post("/api/messages", { topic, body: "retained" }, cookie)).status).toBe(200);
	expect(
		(
			await fetch(app.url + "/api/topics/gone-other", {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
				body: JSON.stringify({ meta: { public: true } }),
			})
		).status,
	).toBe(200);
	const get = (path: string) => fetch(app.url + path, { headers: { cookie } });
	const write = (path: string, method: string, signal?: AbortSignal) =>
		(method === "PUT" ? sourcePut : fetch)(app.url + path, {
			method,
			...(signal ? { signal } : {}),
			headers: { cookie, origin: "https://comms.test" },
			...(method === "PUT" ? { body: "replacement" } : {}),
		});
	// An unacknowledged deletion must not hide the prior published image from authenticated readers.
	await fixture.sql(
		`UPDATE topics SET deleted_at=1,updated_seq=999999,previous=json_object('meta',json(meta),'archived_at',archived_at,'deleted_at',NULL) WHERE path='gone'`,
	);
	expect((await get("/p/gone/deep/readme.md?raw=1")).status).toBe(200);
	const controller = new AbortController();
	test.onTestFinished(() => controller.abort());
	const current = await get("/api/fs/pages/gone/deep/readme.md");
	expect(current.status).toBe(200);
	const baseVersion = current.headers.get("x-comms-base-version");
	if (!baseVersion) throw Error("Missing source base version");
	await current.arrayBuffer();
	await fixture.hold();
	const mutation = app.post("/api/messages", { topic: "publication-held", body: "held publication" }, cookie).then(
		(response) => response.status,
		() => 0,
	);
	await expect.poll(fixture.reserved).not.toBe("");
	let completed = false;
	const pending = fetch(`${app.url}/api/fs/pages/gone/deep/readme.md?baseVersion=${encodeURIComponent(baseVersion)}`, {
		method: "PUT",
		signal: controller.signal,
		headers: { cookie, origin: "https://comms.test" },
		body: "replacement",
	}).then(
		(response) => {
			completed = true;
			return response.status;
		},
		() => {
			completed = true;
			return 0;
		},
	);
	try {
		await expect.poll(fixture.waiting).toBe("waiting");
		expect(completed).toBe(false);
		for (const table of ["versions", "source_batches", "source_changes"])
			expect(await fixture.sql(`SELECT * FROM ${table}`, "boot.db")).toEqual([]);
		expect(await readFile(join(fixture.root, "pages/gone/deep/readme.md"), "utf8")).toBe("# gone/deep");
	} finally {
		await fixture.release();
	}
	expect(await mutation).toBe(200);
	expect(await pending).toBe(200);
	expect(await readFile(join(fixture.root, "pages/gone/deep/readme.md"), "utf8")).toBe("replacement");
	await fixture.sql(`UPDATE topics SET updated_seq=0,previous=NULL WHERE path='gone'`);
	for (const path of [
		"/p/gone/",
		"/p/gone/readme.md",
		"/p/gone/readme.md?raw=1",
		"/p/gone/asset.bin",
		"/p/gone/page-only/",
		"/p/gone/deep/readme.md",
	]) {
		expect((await get(path)).status, path).toBe(404);
		expect((await fetch(app.url + path)).status, path).toBe(401);
	}
	const listing = await (await get("/p/")).text();
	expect(listing).not.toContain('href="/p/gone/"');
	expect(listing).toContain("gone-other");
	expect((await fetch(app.url + "/p/gone-other/readme.md")).status).toBe(200);
	for (const method of ["PUT", "DELETE"])
		expect((await write("/api/fs/pages/gone/page-only/readme.md", method)).status).toBe(200);
	expect(await (await get("/api/fs/pages/gone/readme.md")).text()).toBe("# gone");
	expect((await write("/api/fs/pages/gone-other/readme.md", "PUT")).status).toBe(200);
	await fixture.sql(`ALTER TABLE topics RENAME COLUMN deleted_at TO missing_deleted_at`);
	expect((await write("/api/fs/pages/gone/new.md", "PUT")).status).toBe(200);
}, 20000);
