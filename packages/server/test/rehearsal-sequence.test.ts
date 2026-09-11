import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("rehearses above pruned app events and boot allocation gaps without changing live app data", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "retained", body: "original" }, cookie)).status).toBe(200);
	const metadata = await fetch(`${app.url}/api/topics/retained`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
		body: JSON.stringify({ meta: { status: "updated" } }),
	});
	expect(metadata.status).toBe(200);
	await fixture.sql("DELETE FROM outbox WHERE shipped_at IS NOT NULL");
	// Model consumed allocation gaps beyond every surviving app row; boot remains authoritative.
	await fixture.sql("UPDATE seq SET next=next+100,published_through=next+99 WHERE pending_id IS NULL", "boot.db");
	const sequence = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ next: Schema.Int })))(
		await fixture.sql("SELECT next FROM seq", "boot.db"),
	)[0]?.next;
	if (sequence === undefined) throw new Error("Missing sequence");
	const rows = await fixture.sql("SELECT * FROM messages");
	const topics = await fixture.sql("SELECT * FROM topics");
	const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
	const guarded = `${source}\nif (process.env.STATE === "rehearsal" && Number(process.env.REHEARSAL_SEQUENCE) < ${sequence}) throw new Error("rehearsal sequence reused retained history");\n`;
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const staged = await fetch(`${app.url}/api/fs/app/server.ts?reload=0`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: guarded,
	});
	expect(staged.status).toBe(200);
	expect(await (await app.post("/api/reload?check=1", {}, cookie)).json()).toMatchObject({ status: "checked" });
	expect(await fixture.sql("SELECT * FROM messages")).toEqual(rows);
	expect(await fixture.sql("SELECT * FROM topics")).toEqual(topics);
	expect(await fixture.sql("SELECT pending_id FROM seq", "boot.db")).toEqual([{ pending_id: null }]);
}, 20000);
