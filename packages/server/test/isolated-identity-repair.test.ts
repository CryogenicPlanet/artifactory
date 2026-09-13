import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { storageFixture } from "./fixtures/storage-maintenance.ts";

it("keeps isolated restore admission armed after an invalid adoption diagnostic without authorizing another board", async (test) => {
	const fixture = await storageFixture(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "isolated", body: "retained" }, cookie)).status).toBe(200);
	await fixture.force("hourly");
	await expect.poll(async () => (await fixture.backups()).length).toBe(1);
	await fixture.cycle();
	const [backup] = await fixture.backups();
	if (!backup) throw new Error("Missing fixture backup");
	await app.stop();
	await mkdir(join(fixture.root, "store"));
	for (const suffix of ["", "-wal", "-shm", "-journal"]) {
		await rename(join(fixture.root, `comms.db${suffix}`), join(fixture.root, `store/comms.db${suffix}`)).catch(
			(error: unknown) => {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			},
		);
	}
	await fixture.sql("INSERT INTO settings(key,value) VALUES('app_store_layout','ready')", "boot.db");
	await fixture.sql("UPDATE settings SET value='invalid-adoption' WHERE key='app_store_adoption'", "boot.db");
	const selected = join(fixture.root, "store/comms.db");
	const original = await readFile(selected);
	const originalBackup = await readFile(backup.path);
	const attempts = await fixture.sql("SELECT * FROM child_attempts ORDER BY id", "boot.db");
	const launcher = join(fixture.root, "packages/boot/test/fixtures/launcher.ts");
	await writeFile(launcher, 'process.env.COMMS_ISOLATED = "true";\n' + (await readFile(launcher, "utf8")));
	for (let restart = 0; restart < 2; restart++) {
		const isolated = await fixture.launch();
		await expect.poll(async () => (await fixture.status(isolated.url, cookie)).child.state).toBe("failed");
		expect((await fetch(`${isolated.url}/auth/login`)).status).toBe(200);
		expect((await fetch(`${isolated.url}/_boot/status`)).status).toBe(401);
		const proof = await isolated.signedAssertion("db.restore", { backup: backup.id }, cookie);
		const response = await fetch(`${isolated.url}/_boot/db/restore`, {
			method: "POST",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json", "X-Comms-Assertion": proof },
			body: JSON.stringify({ backup: backup.id }),
		});
		const body = await response.text();
		expect(body).not.toContain("restore_recovery_required");
		expect(response.status).toBe(409);
		expect(JSON.parse(body)).toMatchObject({
			status: "failed",
			error: "restore_preparation_failed",
			safety_backup: null,
		});
		expect(await (await fetch(`${isolated.url}/_boot/status`, { headers: { cookie } })).text()).toContain(
			"app_store_identity_invalid",
		);
		expect((await fetch(`${isolated.url}/api/messages`, { headers: { cookie } })).status).toBe(503);
		await isolated.stop();
		expect(await readFile(selected)).toEqual(original);
		expect(await readFile(backup.path)).toEqual(originalBackup);
		expect(await fixture.sql("SELECT * FROM child_attempts ORDER BY id", "boot.db")).toEqual(attempts);
	}
	// Read only after both byte comparisons: this native fixture connection may checkpoint a retained WAL on close.
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='isolated'", "store/comms.db")).toEqual([
		{ body: "retained" },
	]);
}, 45000);
