import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resetFixture } from "./fixtures/source-reset.ts";

for (const boundary of ["finish", "journal", "release"] as const) {
	it(`retries accepted ${boundary} cleanup without replacing the live writer or losing newer writes`, async (test) => {
		const fixture = await resetFixture(test);
		const app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		const status = async () => (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
		await fixture.sql(
			boundary === "finish"
				? "CREATE TRIGGER fail_cleanup BEFORE UPDATE OF cutover_in_flight ON edit_lock WHEN NEW.cutover_in_flight=0 BEGIN SELECT RAISE(ABORT,'accepted finish unavailable'); END"
				: "CREATE TRIGGER fail_cleanup BEFORE DELETE ON cutover BEGIN SELECT RAISE(ABORT,'accepted journal unavailable'); END",
			"boot.db",
		);
		const originalLock = await fixture.sql("SELECT id FROM edit_lock", "boot.db");
		const staged = await fetch(`${app.url}/api/fs/app/accepted.txt${boundary === "release" ? "?reload=0" : ""}`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test" },
			body: "accepted source",
		});
		if (boundary === "release") expect(staged.status).toBe(200);
		const response = boundary === "release" ? await app.post("/api/reload?release=1", {}, cookie) : staged;
		expect(response.status).toBe(500);
		const accepted = await status();
		expect(accepted).toMatchObject({ child: { state: "live" }, traffic: { frozen: false } });
		const attempts = await fixture.sql("SELECT id,closed FROM child_attempts ORDER BY rowid", "boot.db");
		// Initial, rehearsal, candidate only: even the first cleanup failure must not restart the candidate.
		expect(attempts).toHaveLength(3);
		expect(await fixture.sql("SELECT phase FROM cutover", "boot.db")).toEqual([{ phase: "accepted" }]);
		expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 1 }]);
		expect(
			(await app.post("/api/messages", { topic: "retained", body: "newer acknowledged write" }, cookie)).status,
		).toBe(200);
		const epoch = await fixture.sql("SELECT * FROM kernel_writer");
		const staging = await fixture.sql("SELECT * FROM staging", "boot.db");
		expect(staging).toHaveLength(1);
		// Persistent faults retain the pin and overlay, but do not take down the accepted app.
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(500);
		expect((await status()).child.pid).toBe(accepted.child.pid);
		expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual(staging);
		await fixture.sql("DROP TRIGGER fail_cleanup", "boot.db");
		expect((await app.post("/api/lock", {})).status).toBe(401);
		expect(await fixture.sql("SELECT phase FROM cutover", "boot.db")).toEqual([{ phase: "accepted" }]);
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		expect((await status()).child.pid).toBe(accepted.child.pid);
		expect(await fixture.sql("SELECT id,closed FROM child_attempts ORDER BY rowid", "boot.db")).toEqual(attempts);
		expect(await fixture.sql("SELECT * FROM kernel_writer")).toEqual(epoch);
		expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
		expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 0 }]);
		expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual([]);
		if (boundary === "release")
			expect(await fixture.sql("SELECT id FROM edit_lock", "boot.db")).not.toEqual(originalLock);
		else expect(await fixture.sql("SELECT id FROM edit_lock", "boot.db")).toEqual(originalLock);
		expect(await fixture.sql("SELECT body FROM messages WHERE topic='retained'")).toEqual([
			{ body: "newer acknowledged write" },
		]);
		expect(await readFile(join(fixture.root, "app/accepted.txt"), "utf8")).toBe("accepted source");
		expect((await app.post("/api/messages", { topic: "retained", body: "writer still usable" }, cookie)).status).toBe(
			200,
		);
	}, 30000);
}

it("finishes an accepted reset without consuming the borrowed editor's overlay", async (test) => {
	const fixture = await resetFixture(test);
	const { app, cookie, request, assertPreserved } = await fixture.initialize();
	await fixture.sql(
		"CREATE TRIGGER fail_reset_cleanup BEFORE UPDATE OF cutover_in_flight ON edit_lock WHEN NEW.cutover_in_flight=0 BEGIN SELECT RAISE(ABORT,'reset finish unavailable'); END",
		"boot.db",
	);
	expect((await request()).status).toBe(500);
	const status = async () => (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
	const accepted = await status();
	expect(accepted.child.state).toBe("live");
	expect((await app.post("/api/messages", { topic: "reset", body: "after accepted reset" }, cookie)).status).toBe(200);
	await fixture.sql("DROP TRIGGER fail_reset_cleanup", "boot.db");
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	expect((await status()).child.pid).toBe(accepted.child.pid);
	await assertPreserved();
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='reset' ORDER BY seq")).toEqual([
		{ body: "before reset" },
		{ body: "after accepted reset" },
	]);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
}, 30000);
