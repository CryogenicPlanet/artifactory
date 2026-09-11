import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("releases restored traffic when lock finalization fails after a rejected candidate", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "retained", body: "before failure" }, cookie)).status).toBe(200);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = await readFile(join(import.meta.dirname, "../src/ext/core/schema.ts"), "utf8");
	const changed = source.replace(
		"yield* sql`PRAGMA synchronous = FULL`;",
		'yield* sql`PRAGMA synchronous = FULL`; if (process.env.STATE === "candidate") return yield* Effect.die("candidate rejected");',
	);
	expect(changed).not.toBe(source);
	await fixture.sql(
		"CREATE TRIGGER refuse_finish BEFORE UPDATE OF cutover_in_flight ON edit_lock WHEN NEW.cutover_in_flight=0 BEGIN SELECT RAISE(ABORT,'finish unavailable'); END",
		"boot.db",
	);
	const result = await fetch(`${app.url}/api/fs/app/ext/core/schema.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: changed,
	});
	expect(result.status).toBeGreaterThanOrEqual(400);
	expect((await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()).traffic.frozen).toBe(false);
	expect((await app.post("/api/messages", { topic: "retained", body: "after failure" }, cookie)).status).toBe(200);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='retained' ORDER BY seq")).toEqual([
		{ body: "before failure" },
		{ body: "after failure" },
	]);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
}, 30000);

it("releases unavailable traffic when repairing an initially broken app fails before backup registration", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const source = await readFile(join(seed, "server.ts"), "utf8");
	await writeFile(join(seed, "server.ts"), `throw new Error("initial source broken");\n${source}`);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await expect
		.poll(
			async () => {
				const status = await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
				return { state: status.child.state, attempt: status.child.attempt };
			},
			{ timeout: 15000 },
		)
		.toEqual({ state: "failed", attempt: 3 });
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	await fixture.sql(
		"CREATE TRIGGER refuse_backup BEFORE INSERT ON backups BEGIN SELECT RAISE(ABORT,'backup unavailable'); END",
		"boot.db",
	);
	const result = await fetch(`${app.url}/api/fs/app/server.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: source,
	});
	expect(await result.json()).toMatchObject({ status: "failed", error: expect.stringContaining("backup unavailable") });
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	const status = await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
	expect(status.traffic.frozen).toBe(false);
	expect((await fetch(`${app.url}/api/messages?since=0`, { headers: { cookie } })).status).toBe(503);
	await fixture.sql("DROP TRIGGER refuse_backup", "boot.db");
	expect(await (await app.post("/api/reload", {}, cookie)).json()).toMatchObject({ status: "live" });
	expect((await app.post("/api/messages", { topic: "repaired", body: "accepted after repair" }, cookie)).status).toBe(
		200,
	);
}, 30000);
