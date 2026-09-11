import { readFile } from "node:fs/promises";
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
