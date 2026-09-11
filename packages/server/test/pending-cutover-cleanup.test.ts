import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, type TestContext } from "vitest";
import { resetFixture } from "./fixtures/source-reset.ts";

async function pendingCleanup(test: TestContext, conflict: boolean) {
	const fixture = await resetFixture(test);
	const filename = join(fixture.boot, "src/source-files.ts");
	const source = await readFile(filename, "utf8");
	const marker = join(fixture.root, "cleanup-failure");
	if (conflict) {
		const needle = "return yield* journal.recover;";
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			filename,
			source.replace(
				needle,
				`
			if (yield* fs.exists(${JSON.stringify(marker)}))
				yield* fs.writeFileString(${JSON.stringify(join(fixture.root, "app/conflict.txt"))}, "external third state");
			${needle}`,
			),
		);
		await writeFile(join(fixture.seed, "conflict.txt"), "before");
	} else {
		const needle = "recover: semaphore.withPermit(journal.recover),";
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			filename,
			source.replace(
				needle,
				`recover: semaphore.withPermit(Effect.gen(function* () {
			if (yield* fs.exists(${JSON.stringify(marker)})) yield* sql\`SELECT * FROM injected_cleanup_failure\`;
			return yield* journal.recover;
		})),`,
			),
		);
	}
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "preserved", body: "acknowledged" }, cookie)).status).toBe(200);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const status = async () => (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
	const initial = await status();
	const file = conflict ? "conflict.txt" : "ext/core/schema.ts";
	const original = await readFile(join(fixture.seed, file), "utf8");
	const changed = conflict
		? "desired"
		: original.replace(
				"yield* sql`PRAGMA synchronous = FULL`;",
				'yield* sql`PRAGMA synchronous = FULL`; if (process.env.STATE === "rehearsal") return yield* Effect.die("rehearsal rejected");',
			);
	expect(changed).not.toBe(original);
	const stage = (body: string) =>
		fetch(`${app.url}/api/fs/app/${file}?reload=0`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test" },
			body,
		});
	expect((await stage(changed)).status).toBe(200);
	const staging = await fixture.sql("SELECT * FROM staging", "boot.db");
	await writeFile(marker, "fail cleanup");
	const rejected = await app.post("/api/reload", {}, cookie);
	expect(rejected.status).toBe(conflict ? 409 : 500);
	expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 1 }]);
	expect((await status()).child.pid).toBe(initial.child.pid);
	return { fixture, app, cookie, marker, status, initial, staging, stage, original };
}

it("retries the exact rollback cleanup on the next authorized lock action without replacing the healthy child", async (test) => {
	const { fixture, app, cookie, marker, status, initial, staging, stage, original } = await pendingCleanup(test, false);
	const generations = await fixture.sql("SELECT n FROM generations ORDER BY n", "boot.db");
	await rm(marker);
	expect((await app.post("/api/lock", {})).status).toBe(401);
	expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 1 }]);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 0 }]);
	expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual(staging);
	expect(await fixture.sql("SELECT n FROM generations ORDER BY n", "boot.db")).toEqual(generations);
	expect((await status()).child.pid).toBe(initial.child.pid);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='preserved'")).toEqual([{ body: "acknowledged" }]);
	// A new proposal now succeeds: the failed operation's preparedRef was also cleared.
	expect((await stage(original)).status).toBe(200);
	expect(await (await app.post("/api/reload", {}, cookie)).json()).toMatchObject({ status: "live" });
}, 30000);

it("keeps the journal and pin while cleanup sees an external source conflict, then repairs without child replacement", async (test) => {
	const { fixture, app, cookie, marker, status, initial, staging } = await pendingCleanup(test, true);
	const journal = await fixture.sql("SELECT * FROM source_changes", "boot.db");
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(409);
	expect(await fixture.sql("SELECT * FROM source_changes", "boot.db")).toEqual(journal);
	expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 1 }]);
	expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual(staging);
	expect(await readFile(join(fixture.root, "app/conflict.txt"), "utf8")).toBe("external third state");
	expect((await status()).child.pid).toBe(initial.child.pid);
	await rm(marker);
	await writeFile(join(fixture.root, "app/conflict.txt"), "before");
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	expect(await readFile(join(fixture.root, "app/conflict.txt"), "utf8")).toBe("desired");
	expect(await fixture.sql("SELECT * FROM source_changes", "boot.db")).toEqual([]);
	expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 0 }]);
	expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual(staging);
	expect((await status()).child.pid).toBe(initial.child.pid);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='preserved'")).toEqual([{ body: "acknowledged" }]);
}, 30000);
