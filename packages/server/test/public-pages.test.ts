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
	const metadata = async (topic: string, meta: object) =>
		expect(
			(
				await fetch(app.url + "/api/topics/" + topic, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
					body: JSON.stringify({ meta }),
				})
			).status,
		).toBe(200);
	for (const topic of ["guide", "guide/yes", "guide/no", "guide-other"])
		expect((await app.post("/api/messages", { topic, body: "private conversation" }, cookie)).status).toBe(200);
	expect((await fetch(app.url + "/p/guide/readme.md")).status).toBe(401);
	await metadata("guide", { public: true });
	await metadata("guide/yes", { public: true });
	const response = await fetch(app.url + "/p/guide/readme.md");
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("<h1>guide</h1>");
	expect(await (await fetch(app.url + "/p/guide/readme.md?raw=1")).text()).toBe("# guide");
	const head = await fetch(app.url + "/p/guide/readme.md", { method: "HEAD" });
	expect(head.status).toBe(200);
	expect(await head.text()).toBe("");
	expect(Buffer.from(await (await fetch(app.url + "/p/guide/asset.bin")).arrayBuffer())).toEqual(
		Buffer.from([0, 1, 255]),
	);
	const listing = await (await fetch(app.url + "/p/guide/")).text();
	expect(listing).toContain("guide/yes/");
	expect(listing).not.toContain("guide/no/");
	expect((await fetch(app.url + "/p/guide", { redirect: "manual" })).status).toBe(302);
	for (const path of [
		"/p/",
		"/p/guide/no/readme.md",
		"/p/guide-other/readme.md",
		"/api/topics/guide",
		"/api/messages?topic=guide",
	])
		expect((await fetch(app.url + path)).status, path).toBe(401);
	expect((await fetch(app.url + "/p/guide/readme.md", { method: "POST" })).status).toBe(401);
	expect((await fetch(app.url + "/p/guide/readme.md", { headers: { authorization: "Bearer invalid" } })).status).toBe(
		401,
	);
	await writeFile(join(fixture.root, "pages", "guide", "index.md"), "# Public index");
	expect(await (await fetch(app.url + "/p/guide/")).text()).toContain("<h1>Public index</h1>");
	await metadata("guide", { public: false });
	expect((await fetch(app.url + "/p/guide/readme.md")).status).toBe(401);
	expect((await fetch(app.url + "/p/guide/yes/readme.md")).status).toBe(200);
	for (const meta of [{ public: "true" }, { public: 1 }, {}]) {
		await metadata("guide", meta);
		expect((await fetch(app.url + "/p/guide/readme.md")).status).toBe(401);
	}
}, 20000);

it("refuses forged grants and broken projection while preserving reads during unrelated publication", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages", "guide"), { recursive: true });
	await writeFile(join(fixture.root, "pages", "guide", "normal.md"), "public content");
	await writeFile(join(fixture.root, "secret.txt"), "outside private content");
	await symlink(join(fixture.root, "secret.txt"), join(fixture.root, "pages", "guide", "link.md"));
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const metadata = async (topic: string, meta: object) =>
		expect(
			(
				await fetch(app.url + "/api/topics/" + topic, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
					body: JSON.stringify({ meta }),
				})
			).status,
		).toBe(200);
	expect((await app.post("/api/messages", { topic: "guide", body: "private" }, cookie)).status).toBe(200);
	const forged = encodeURIComponent("guide/normal.md");
	expect((await fetch(app.url + "/p/guide/normal.md", { headers: { "x-chirp-public-page": forged } })).status).toBe(
		401,
	);
	await metadata("guide", { public: true });
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
	expect((await fetch(app.url + "/p/guide/normal.md")).status).toBe(200);
	expect((await fetch(app.url + "/p/guide/normal.md", { headers: { cookie } })).status).toBe(200);
	await fixture.sql(`UPDATE seq SET pending_id=NULL`, "boot.db");
	expect((await fetch(app.url + "/p/guide/normal.md")).status).toBe(200);
	await fixture.sql(`ALTER TABLE public_paths RENAME COLUMN path TO broken_path`, "boot.db");
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
	expect(
		(
			await fetch(first.url + "/api/topics/guide", {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
				body: JSON.stringify({ meta: { public: true } }),
			})
		).status,
	).toBe(200);
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
	const unavailable = await fetch(restarted.url + "/p/guide/file.md");
	const body = await unavailable.text();
	expect({ status: unavailable.status, body: JSON.parse(body) }).toEqual({
		status: 503,
		body: {
			error: { code: "boot_unavailable", retriable: true, message: expect.any(String), hint: expect.any(String) },
		},
	});
	expect(body).not.toContain("public after recovery only");
	expect(body).not.toContain("cutover_backup_invalid");
	const head = await fetch(restarted.url + "/p/guide/file.md", { method: "HEAD" });
	expect(head.status).toBe(503);
	expect(await head.text()).toBe("");
	for (const headers of [{ authorization: "Bearer invalid" }, { cookie: "__Host-comms_session=invalid" }])
		expect((await fetch(restarted.url + "/p/guide/file.md", { headers })).status).toBe(401);
	expect((await fetch(restarted.url + "/_boot/status", { headers: { cookie } })).status).toBe(200);
}, 20000);

it("reconstructs cleared grants from the adopted app before routing the restarted child", async (test) => {
	const fixture = await conversation(test);
	for (const topic of ["guide", "guide/private", "gone", "gone/child"]) {
		await mkdir(join(fixture.root, "pages", topic), { recursive: true });
		await writeFile(join(fixture.root, "pages", topic, "index.md"), `# ${topic}`);
	}
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	for (const topic of ["guide", "gone/child"]) {
		const response = await fetch(app.url + "/api/topics/" + topic, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
			body: JSON.stringify({ meta: { public: true } }),
		});
		expect(response.status).toBe(200);
	}
	await app.stop();
	// A restored/adopted app must republish grants into the boot projection before it receives traffic.
	await fixture.sql("DELETE FROM public_paths", "boot.db");
	await fixture.sql("UPDATE topics SET deleted_at=1 WHERE path='gone'");
	const restarted = await fixture.launch();
	await restarted.ready(cookie);
	expect((await fetch(restarted.url + "/p/guide/")).status).toBe(200);
	expect((await fetch(restarted.url + "/p/guide/private/")).status).toBe(401);
	expect((await fetch(restarted.url + "/p/gone/child/")).status).toBe(401);
	expect(await fixture.sql("SELECT path FROM public_paths ORDER BY path", "boot.db")).toEqual([{ path: "guide" }]);
}, 20000);
