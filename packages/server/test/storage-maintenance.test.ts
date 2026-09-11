import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { storageFixture } from "./fixtures/storage-maintenance.ts";

it("captures acknowledged WAL data and drills a private copy without changing live ownership, then remembers scheduling across restart", async (test) => {
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
	const messages = await fixture.sql("SELECT seq,body FROM messages ORDER BY seq");
	await cp(join(fixture.root, "comms.db"), join(fixture.root, "main-only.db"));
	expect(
		await fixture.sql("SELECT seq,body FROM messages ORDER BY seq", "main-only.db").catch((error: unknown) => {
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
		await fixture.sql("SELECT seq,body FROM messages ORDER BY seq", join("backups", basename(saved.path))),
	).toEqual(messages);
	expect(
		await fixture.sql(
			`SELECT COUNT(*) count FROM messages WHERE updated_seq>${saved.published_through}`,
			join("backups", basename(saved.path)),
		),
	).toEqual([{ count: 0 }]);
	const bytes = await readFile(saved.path);
	await fixture.force("drill");
	await expect.poll(fixture.drills, { timeout: 15000 }).toEqual([{ ok: 1 }]);
	expect(await readFile(saved.path)).toEqual(bytes);
	expect((await fixture.status(app.url, cookie)).child).toEqual(owner.child);
	expect(await fixture.sql("SELECT * FROM kernel_writer")).toEqual(epoch);
	expect(await fixture.sql("SELECT seq,body FROM messages ORDER BY seq")).toEqual(messages);
	expect(
		await fixture.sql(
			"SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='message.created'",
			"boot.db",
		),
	).toEqual([{ count: 1 }]);
	expect(await fixture.sql("SELECT opened,closed FROM child_attempts ORDER BY rowid", "boot.db")).toEqual([
		{ opened: 1, closed: 0 },
		{ opened: 0, closed: 1 },
	]);
	expect((await readdir(fixture.root)).filter((name) => name.startsWith(".backup-drill-"))).toEqual([]);
	const attempts = await fixture.sql(
		"SELECT key,value FROM settings WHERE key LIKE 'backup.%attempt_at' ORDER BY key",
		"boot.db",
	);
	await app.stop();
	const resumed = await fixture.launch(),
		again = await resumed.login();
	await resumed.ready(again);
	await fixture.cycle();
	await fixture.cycle();
	expect(await fixture.backups()).toEqual([saved]);
	expect(await fixture.drills()).toEqual([{ ok: 1 }]);
	expect(
		await fixture.sql("SELECT key,value FROM settings WHERE key LIKE 'backup.%attempt_at' ORDER BY key", "boot.db"),
	).toEqual(attempts);
	expect(await readFile(saved.path)).toEqual(bytes);
}, 30000);

it("reports a corrupt backup drill without changing the live store and can run the next due drill", async (test) => {
	const fixture = await storageFixture(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(
		(await app.post("/api/messages", { topic: "backup", body: "live data survives corrupt backup" }, cookie)).status,
	).toBe(200);
	await fixture.force("hourly");
	await expect.poll(async () => (await fixture.backups()).length, { timeout: 10000 }).toBe(1);
	await fixture.cycle();
	const [saved] = await fixture.backups();
	if (!saved) throw Error("Missing hourly backup");
	const bytes = await readFile(saved.path);
	const owner = await fixture.status(app.url, cookie);
	const epoch = await fixture.sql("SELECT * FROM kernel_writer");
	const rows = await fixture.sql("SELECT * FROM messages");
	await writeFile(saved.path, "deliberately corrupt only the disposable backup");
	await fixture.force("drill");
	await expect.poll(fixture.drills, { timeout: 10000 }).toEqual([{ ok: 0 }]);
	expect((await fixture.status(app.url, cookie)).child).toEqual(owner.child);
	expect(await fixture.sql("SELECT * FROM kernel_writer")).toEqual(epoch);
	expect(await fixture.sql("SELECT * FROM messages")).toEqual(rows);
	expect((await readdir(fixture.root)).filter((name) => name.startsWith(".backup-drill-"))).toEqual([]);
	await writeFile(saved.path, bytes);
	await fixture.sql("PRAGMA user_version=999", join("backups", basename(saved.path)));
	await fixture.force("drill");
	await expect.poll(fixture.drills, { timeout: 40000 }).toEqual([{ ok: 0 }, { ok: 0 }]);
	expect(await fixture.sql("SELECT opened,closed FROM child_attempts ORDER BY rowid", "boot.db")).toEqual([
		{ opened: 1, closed: 0 },
		{ opened: 0, closed: 1 },
	]);
	expect((await readdir(fixture.root)).filter((name) => name.startsWith(".backup-drill-"))).toEqual([]);
	await writeFile(saved.path, bytes);
	await fixture.force("drill");
	await expect.poll(fixture.drills, { timeout: 15000 }).toEqual([{ ok: 0 }, { ok: 0 }, { ok: 1 }]);
	expect(await fixture.sql("SELECT * FROM messages")).toEqual(rows);
}, 60000);

it("drains an admitted body before capture while a concurrent source reload waits for the maintenance gate", async (test) => {
	const fixture = await storageFixture(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
	expect(
		(
			await fetch(`${app.url}/api/fs/app/server.ts?reload=0`, {
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
	const completed = new Promise<number>((resolve) => {
		upload.on("error", () => resolve(0));
		upload.on("response", (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode ?? 0));
		});
	});
	upload.write('{"topic":"backup","body":"');
	await expect.poll(async () => (await fixture.status(app.url, cookie)).traffic).toMatchObject({ admitted: 1 });
	await fixture.force("hourly");
	await expect
		.poll(async () => (await fixture.status(app.url, cookie)).traffic)
		.toMatchObject({ frozen: true, admitted: 1 });
	const reload = app.post("/api/reload?release=1", {}, cookie);
	await expect.poll(() => readFile(fixture.reloadWaiting, "utf8").catch(() => "")).toBe("waiting");
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	expect(await fixture.backups()).toEqual([]);
	upload.end('drained into hourly backup"}');
	expect(await completed).toBe(200);
	expect(await (await reload).json()).toMatchObject({ status: "live" });
	const saved = (await fixture.backups()).find((row) => row.reason === "hourly");
	if (!saved) throw Error("Missing hourly backup");
	expect(await fixture.sql("SELECT body FROM messages", join("backups", basename(saved.path)))).toEqual([
		{ body: "drained into hourly backup" },
	]);
	expect(await fixture.sql("SELECT body FROM messages")).toEqual([{ body: "drained into hourly backup" }]);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
}, 30000);

it("keeps rehearsal scratch bytes and refuses further maintenance and reload when closure proof is missing", async (test) => {
	const fixture = await storageFixture(test, true),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(
		(await app.post("/api/messages", { topic: "backup", body: "live store stays authoritative" }, cookie)).status,
	).toBe(200);
	const owner = await fixture.status(app.url, cookie);
	const epoch = await fixture.sql("SELECT * FROM kernel_writer");
	const rows = await fixture.sql("SELECT * FROM messages");
	await fixture.force("both");
	await expect.poll(fixture.drills, { timeout: 15000 }).toEqual([{ ok: 0 }]);
	const backups = await fixture.backups();
	expect(backups).toHaveLength(1);
	expect((await readdir(fixture.root)).filter((name) => name.startsWith(".backup-drill-"))).toHaveLength(1);
	expect(await fixture.sql("SELECT opened,closed FROM child_attempts ORDER BY rowid", "boot.db")).toEqual([
		{ opened: 1, closed: 0 },
		{ opened: 0, closed: 0 },
	]);
	await fixture.force("both");
	await fixture.cycle();
	await fixture.cycle();
	expect(await fixture.backups()).toEqual(backups);
	expect(await fixture.drills()).toEqual([{ ok: 0 }]);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
	expect(
		(
			await fetch(`${app.url}/api/fs/app/server.ts?reload=0`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: source,
			})
		).status,
	).toBe(200);
	const reload = await app.post("/api/reload", {}, cookie);
	expect(reload.status).toBeGreaterThanOrEqual(400);
	expect(await reload.json()).toMatchObject({ error: { code: "edit_unavailable" } });
	expect(await fixture.sql("SELECT COUNT(*) count FROM child_attempts", "boot.db")).toEqual([{ count: 2 }]);
	expect((await fixture.status(app.url, cookie)).child).toEqual(owner.child);
	expect(await fixture.sql("SELECT * FROM kernel_writer")).toEqual(epoch);
	expect(await fixture.sql("SELECT * FROM messages")).toEqual(rows);
}, 30000);
