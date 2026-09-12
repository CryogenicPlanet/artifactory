import { sourcePut } from "./fixtures/source-put.ts";
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
	// The live system view may mirror lock/rehearsal diagnostics while the clone is checked.
	const originalSystem = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
		await fixture.sql("SELECT * FROM messages WHERE topic='system'"),
	);
	const rows = await fixture.sql("SELECT * FROM messages WHERE topic!='system'");
	const topics = await fixture.sql("SELECT * FROM topics WHERE path!='system'");
	const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
	const guarded = `${source}\nif (process.env.STATE === "rehearsal" && Number(process.env.REHEARSAL_SEQUENCE) < ${sequence}) throw new Error("rehearsal sequence reused retained history");\n`;
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const staged = await sourcePut(`${app.url}/api/fs/app/server.ts?reload=0`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: guarded,
	});
	expect(staged.status).toBe(200);
	expect(await (await app.post("/api/reload?check=1", {}, cookie)).json()).toMatchObject({ status: "checked" });
	expect(await fixture.sql("SELECT * FROM messages WHERE topic!='system'")).toEqual(rows);
	expect(await fixture.sql("SELECT * FROM topics WHERE path!='system'")).toEqual(topics);
	expect(await fixture.sql("SELECT * FROM messages WHERE topic='system'")).toEqual(
		expect.arrayContaining([...originalSystem]),
	);
	// The live system mirror may reserve independently after rehearsal returns.
	// Prove that the observed batch publishes, then require the allocator to settle.
	const pendingRows = Schema.decodeUnknownSync(
		Schema.Tuple([Schema.Struct({ pending_id: Schema.NullOr(Schema.String) })]),
	);
	const batches = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String, state: Schema.String })));
	const observed = pendingRows(await fixture.sql("SELECT pending_id FROM seq", "boot.db"))[0].pending_id;
	try {
		await expect
			.poll(
				async () => {
					const pending = pendingRows(await fixture.sql("SELECT pending_id FROM seq", "boot.db"))[0].pending_id;
					const state =
						observed === null
							? "published"
							: batches(await fixture.sql("SELECT id,state FROM event_batches", "boot.db")).find(
									(batch) => batch.id === observed,
								)?.state;
					return { pending, state };
				},
				{ timeout: 5000 },
			)
			.toEqual({ pending: null, state: "published" });
	} catch (cause) {
		throw new Error(
			JSON.stringify({
				observed,
				allocator: await fixture.sql("SELECT pending_id FROM seq", "boot.db"),
				batches: await fixture.sql("SELECT id,state FROM event_batches", "boot.db"),
				outbox: await fixture.sql("SELECT seq,transaction_id,shipped_at FROM outbox"),
			}),
			{ cause },
		);
	}
}, 20000);
