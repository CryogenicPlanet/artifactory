import { sourcePut } from "./fixtures/source-put.ts";
import { cp, readFile } from "node:fs/promises";
import { request } from "node:http";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { Schema } from "effect";
import { storageFixture } from "./fixtures/storage-maintenance.ts";

it("captures acknowledged WAL data without changing live ownership and does not immediately repeat an app-scheduled backup across restart", async (test) => {
	const fixture = await storageFixture(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(
		(await app.post("/api/messages", { topic: "backup", body: "acknowledged before capture" }, cookie)).status,
	).toBe(200);
	const owner = await fixture.status(app.url, cookie);
	const epoch = await fixture.sql("SELECT * FROM kernel_writer");
	const messages = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
	// Backup includes every pre-capture row, including the resumable system view.
	await expect
		.poll(() => fixture.sql("SELECT 1 present FROM messages WHERE topic='system' LIMIT 1"))
		.toEqual([{ present: 1 }]);
	const allMessages = Schema.decodeUnknownSync(
		Schema.Array(Schema.Struct({ id: Schema.String, seq: Schema.Int, body: Schema.String, topic: Schema.String })),
	)(await fixture.sql("SELECT id,seq,body,topic FROM messages ORDER BY seq"));
	expect(allMessages.some((row) => row.topic === "system")).toBe(true);
	const through = Math.max(...allMessages.map((row) => row.seq));

	await cp(join(fixture.root, "comms.db"), join(fixture.root, "main-only.db"));
	expect(
		await fixture
			.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq", "main-only.db")
			.catch((error: unknown) => {
				if (error instanceof Error && error.message.includes("no such table: messages")) return [];
				throw error;
			}),
	).not.toEqual(messages);
	await fixture.force("hourly");
	await expect.poll(async () => (await fixture.backups()).length, { timeout: 10000 }).toBe(1);
	await fixture.cycle();
	const [saved] = await fixture.backups();
	if (!saved) throw Error("Missing hourly backup");
	expect(saved.reason).toBe("hourly");
	expect(saved.generation).toBe(owner.child.generation);
	expect(
		await fixture.sql(
			`SELECT id,seq,body,topic FROM messages WHERE seq<=${through} ORDER BY seq`,
			join("backups", basename(saved.path)),
		),
	).toEqual(allMessages);

	expect(
		await fixture.sql(
			"SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq",
			join("backups", basename(saved.path)),
		),
	).toEqual(messages);
	expect(
		await fixture.sql(
			`SELECT COUNT(*) count FROM messages WHERE updated_seq>${saved.published_through}`,
			join("backups", basename(saved.path)),
		),
	).toEqual([{ count: 0 }]);
	const bytes = await readFile(saved.path);
	expect((await fixture.status(app.url, cookie)).child).toEqual(owner.child);
	expect(await fixture.sql("SELECT * FROM kernel_writer")).toEqual(epoch);
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(messages);
	expect(
		await fixture.sql(
			"SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='message.created' AND json_extract(event,'$.topic')='backup'",
			"boot.db",
		),
	).toEqual([{ count: 1 }]);
	expect(await fixture.sql("SELECT opened,closed FROM child_attempts ORDER BY rowid", "boot.db")).toEqual([
		{ opened: 1, closed: 0 },
	]);
	await app.stop();
	const resumed = await fixture.launch(),
		again = await resumed.login();
	await resumed.ready(again);
	await fixture.cycle();
	await fixture.cycle();
	expect(await fixture.backups()).toEqual([saved]);

	expect(await readFile(saved.path)).toEqual(bytes);
}, 30000);

it("drains an admitted body before capture while a concurrent source reload waits for the maintenance gate", async (test) => {
	const fixture = await storageFixture(test, true),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
	expect(
		(
			await sourcePut(`${app.url}/api/fs/app/server.ts?reload=0`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: source,
			})
		).status,
	).toBe(200);
	const upload = request(`${app.url}/api/messages`, {
		method: "POST",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
	});
	test.onTestFinished(() => {
		upload.destroy();
	});
	const completed = new Promise<{ status: number; body: string }>((resolve) => {
		upload.on("error", () => resolve({ status: 0, body: "upload_error" }));
		upload.on("response", (response) => {
			let body = "";
			response.on("data", (chunk: Buffer) => {
				body = (body + chunk.toString()).slice(0, 2048);
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
	});
	upload.write('{"topic":"backup","body":"');
	await expect.poll(async () => (await fixture.status(app.url, cookie)).traffic).toMatchObject({ admitted: 1 });
	await expect.poll(() => readFile(fixture.forwarding, "utf8").catch(() => "")).toBe("admitted");
	await fixture.force("hourly");
	await expect
		.poll(async () => (await fixture.status(app.url, cookie)).traffic)
		.toMatchObject({ frozen: true, admitted: 1 });
	// Observe rejection immediately, even if an upload assertion fails before reload is awaited.
	const reload = app.post("/api/reload?release=1", {}, cookie).then(
		(response) => ({ response, error: null }),
		(error: unknown) => ({ response: null, error }),
	);
	await expect.poll(() => readFile(fixture.reloadWaiting, "utf8").catch(() => "")).toBe("waiting");
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	expect(await fixture.backups()).toEqual([]);
	await expect.poll(() => readFile(fixture.childFrozen, "utf8").catch(() => "")).toBe("Success");
	const child = (await fixture.status(app.url, cookie)).child;
	if (child.port === null) throw Error("Missing live child port");
	for (const secret of [undefined, "wrong"]) {
		const denied = await fetch(`http://127.0.0.1:${child.port}/api/messages`, {
			method: "POST",
			headers: { "x-chirp-request-id": "a".repeat(32), ...(secret ? { "x-boot-secret": secret } : {}) },
			body: "{}",
		});
		expect(denied.status).toBe(403);
	}
	const forged = fetch(`${app.url}/api/does-not-exist`, {
		method: "POST",
		headers: { cookie, origin: "https://comms.test", "x-chirp-request-id": "a".repeat(32) },
		body: "{}",
	}).then(
		(response) => ({ response, error: null }),
		(error: unknown) => ({ response: null, error }),
	);
	await expect
		.poll(async () => (await fixture.status(app.url, cookie)).traffic)
		.toMatchObject({ frozen: true, admitted: 1, queued: 1 });
	await fixture.releaseForwarding();
	upload.end('drained into hourly backup"}');
	const uploaded = await completed;
	expect(uploaded.status, `Admitted upload response: ${uploaded.body || "<empty>"}`).toBe(200);
	const reloaded = await reload;
	if (reloaded.error) throw reloaded.error;
	if (!reloaded.response) throw Error("Missing reload response");
	expect(await reloaded.response.json()).toMatchObject({ status: "live" });
	const forgedResult = await forged;
	if (forgedResult.error) throw forgedResult.error;
	expect(forgedResult.response?.status).toBe(404);
	const saved = (await fixture.backups()).find((row) => row.reason === "hourly");
	if (!saved) throw Error("Missing hourly backup");
	expect(
		await fixture.sql("SELECT body FROM messages WHERE topic!='system'", join("backups", basename(saved.path))),
	).toEqual([{ body: "drained into hourly backup" }]);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic!='system'")).toEqual([
		{ body: "drained into hourly backup" },
	]);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
}, 30000);
