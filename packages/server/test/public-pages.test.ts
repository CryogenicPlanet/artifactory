import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("opens only exact opted-in page topics and filters anonymous directory listings", async (test) => {
	const fixture = await conversation(test);
	for (const topic of ["guide", "guide/yes", "guide/no", "guide-other"]) {
		await mkdir(join(fixture.root, "pages", topic), { recursive: true });
		await writeFile(join(fixture.root, "pages", topic, "readme.md"), `# ${topic}`);
	}
	await writeFile(join(fixture.root, "pages", "guide", "asset.bin"), Buffer.from([0, 1, 255]));
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	// Anonymous policy deliberately returns 503 while unrelated publication/recovery is pending.
	// Retry only reads; the separate pending-policy test below still requires that immediate refusal.
	const readPage = async (path: string, init?: RequestInit) => {
		let response = await fetch(app.url + path, init);
		await expect
			.poll(
				async () => {
					if (response.status === 503) {
						await response.arrayBuffer();
						response = await fetch(app.url + path, init);
					}
					return response.status;
				},
				{ timeout: 3000 },
			)
			.not.toBe(503);
		return response;
	};
	for (const topic of ["guide", "guide/yes", "guide/no", "guide-other"])
		expect((await app.post("/api/messages", { topic, body: "private conversation" }, cookie)).status).toBe(200);
	expect((await readPage("/p/guide/readme.md")).status).toBe(401);
	await fixture.sql(`UPDATE topics SET meta='{"public":true}' WHERE path IN ('guide','guide/yes')`);
	const response = await readPage("/p/guide/readme.md");
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("<h1>guide</h1>");
	expect(await (await readPage("/p/guide/readme.md?raw=1")).text()).toBe("# guide");
	const head = await readPage("/p/guide/readme.md", { method: "HEAD" });
	expect(head.status).toBe(200);
	expect(await head.text()).toBe("");
	expect(Buffer.from(await (await readPage("/p/guide/asset.bin")).arrayBuffer())).toEqual(Buffer.from([0, 1, 255]));
	const listing = await (await readPage("/p/guide/")).text();
	expect(listing).toContain("guide/yes/");
	expect(listing).not.toContain("guide/no/");
	expect((await readPage("/p/guide", { redirect: "manual" })).status).toBe(302);
	for (const path of [
		"/p/",
		"/p/guide/no/readme.md",
		"/p/guide-other/readme.md",
		"/api/topics/guide",
		"/api/messages?topic=guide",
	])
		expect((await readPage(path)).status, path).toBe(401);
	expect((await fetch(app.url + "/p/guide/readme.md", { method: "POST" })).status).toBe(401);
	expect((await readPage("/p/guide/readme.md", { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
	await writeFile(join(fixture.root, "pages", "guide", "index.md"), "# Public index");
	expect(await (await readPage("/p/guide/")).text()).toContain("<h1>Public index</h1>");
	await fixture.sql(`UPDATE topics SET meta='{"public":false}' WHERE path='guide'`);
	expect((await readPage("/p/guide/readme.md")).status).toBe(401);
	expect((await readPage("/p/guide/yes/readme.md")).status).toBe(200);
	for (const meta of ['{"public":"true"}', '{"public":1}', "{}"]) {
		await fixture.sql(`UPDATE topics SET meta='${meta}' WHERE path='guide'`);
		expect((await readPage("/p/guide/readme.md")).status).toBe(401);
	}
}, 20000);

it("refuses forged page grants, ambiguous paths and unpublished or broken policy data", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages", "guide"), { recursive: true });
	await writeFile(join(fixture.root, "pages", "guide", "normal.md"), "public content");
	await writeFile(join(fixture.root, "secret.txt"), "outside private content");
	await symlink(join(fixture.root, "secret.txt"), join(fixture.root, "pages", "guide", "link.md"));
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "guide", body: "private" }, cookie)).status).toBe(200);
	const forged = encodeURIComponent(JSON.stringify({ path: "guide/normal.md", children: [] }));
	expect((await fetch(app.url + "/p/guide/normal.md", { headers: { "x-comms-public-page": forged } })).status).toBe(
		401,
	);
	await fixture.sql(`UPDATE topics SET meta='{"public":true}' WHERE path='guide'`);
	for (const path of [
		"/p/guide/link.md",
		"/p/guide%2fnormal.md",
		"/p/guide%2f..%2f..%2fsecret.txt",
		"/p/guide/a%5cb",
		"/p/guide/.comms-private.tmp",
	]) {
		const response = await fetch(app.url + path);
		expect(response.status, path).toBe(401);
		expect(await response.text()).not.toContain("outside private content");
	}
	expect((await fetch(app.url + "/p/guide/%ff")).status).toBe(404);
	await fixture.sql(`UPDATE seq SET pending_id='held'`, "boot.db");
	expect((await fetch(app.url + "/p/guide/normal.md")).status).toBe(503);
	expect((await fetch(app.url + "/p/guide/normal.md", { headers: { cookie } })).status).toBe(200);
	await fixture.sql(`UPDATE seq SET pending_id=NULL`, "boot.db");
	expect((await fetch(app.url + "/p/guide/normal.md")).status).toBe(200);
	await fixture.sql(`UPDATE topics SET meta='invalid json' WHERE path='guide'`);
	const broken = await fetch(app.url + "/p/guide/normal.md");
	expect(broken.status).toBe(503);
	expect(await broken.text()).not.toContain("public content");
	expect((await fetch(app.url + "/health")).status).toBe(200);
}, 20000);

it("keeps anonymous page policy closed when startup cutover recovery has not succeeded", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages", "guide"), { recursive: true });
	await writeFile(join(fixture.root, "pages", "guide", "file.md"), "public after recovery only");
	const first = await fixture.launch();
	await first.setup();
	const cookie = await first.login();
	await first.ready(cookie);
	expect((await first.post("/api/messages", { topic: "guide", body: "message" }, cookie)).status).toBe(200);
	await fixture.sql(`UPDATE topics SET meta='{"public":true}' WHERE path='guide'`);
	expect((await fetch(first.url + "/p/guide/file.md")).status).toBe(200);
	await first.stop();
	await fixture.sql(`INSERT INTO cutover VALUES(1,2,1,'missing-backup','lock','family','working',NULL)`, "boot.db");
	const restarted = await fixture.launch();
	await expect
		.poll(
			async () => {
				const response = await fetch(restarted.url + "/_boot/status", { headers: { cookie } });
				const status: unknown = await response.json();
				return typeof status === "object" &&
					status !== null &&
					"source_recovery_error" in status &&
					typeof status.source_recovery_error === "string"
					? status.source_recovery_error
					: "";
			},
			{ timeout: 5000 },
		)
		.toContain("cutover_backup_invalid");
	expect((await fetch(restarted.url + "/p/guide/file.md")).status).toBe(401);
	expect((await fetch(restarted.url + "/_boot/status", { headers: { cookie } })).status).toBe(200);
}, 20000);
