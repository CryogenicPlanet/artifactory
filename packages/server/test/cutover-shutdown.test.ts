import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("repairs never-ending shutdown hooks and scoped finalizers only after keeper closure, preserving acknowledged writes", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/hang.ts"),
		'import {Effect} from "effect"; export default api => api.on("shutdown", () => Effect.never);',
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const retained: Array<{ body: string }> = [{ body: "acknowledged before failed backup" }];
	expect((await app.post("/api/messages", { topic: "hang", body: retained[0]?.body }, cookie)).status).toBe(200);
	// Failure after forced closure but before the backup checkpoint must restart
	// the known-good code against the current store, not strand the frozen gate.
	await writeFile(join(fixture.root, "backups"), "blocks backup directory creation");
	const failed = await fetch(`${app.url}/api/fs/app/ext/hang.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: "export default function repaired() {}",
		signal: AbortSignal.timeout(25000),
	});
	expect(await failed.json()).toMatchObject({ status: "failed", lock: { cutover_in_flight: 0 } });
	expect(await fixture.sql("SELECT body FROM messages ORDER BY seq")).toEqual(retained);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	expect((await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()).traffic.frozen).toBe(false);
	await rm(join(fixture.root, "backups"));
	const fixes = [
		'import {Effect} from "effect"; export default api => api.on("start", () => Effect.addFinalizer(() => Effect.never));',
		"export default function repaired() {}",
	];
	for (const [index, source] of fixes.entries()) {
		const body = `acknowledged before repair ${index}`;
		expect((await app.post("/api/messages", { topic: "hang", body }, cookie)).status).toBe(200);
		retained.push({ body });
		const owners = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String, receipt: Schema.String })))(
			await fixture.sql("SELECT id,receipt FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
		);
		expect(owners).toHaveLength(1);
		const response = await fetch(`${app.url}/api/fs/app/ext/hang.ts`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test" },
			body: source,
			signal: AbortSignal.timeout(25000),
		});
		expect(await response.json()).toMatchObject({ status: "live", lock: { cutover_in_flight: 0 } });
		for (const owner of owners) {
			expect(await readFile(owner.receipt, "utf8")).toBe(owner.id);
		}
		expect(
			await fixture.sql("SELECT COUNT(*) AS count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
		).toEqual([{ count: 1 }]);
		expect(await fixture.sql("SELECT body FROM messages ORDER BY seq")).toEqual(retained);
		expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	}
	expect((await app.post("/api/messages", { topic: "hang", body: "acknowledged after repair" }, cookie)).status).toBe(
		200,
	);
	retained.push({ body: "acknowledged after repair" });
	expect(await fixture.sql("SELECT body FROM messages ORDER BY seq")).toEqual(retained);
	const events = await (
		await fetch(`${app.url}/api/events?since=0&types=message.created`, { headers: { cookie } })
	).json();
	expect(events.items.map((event: { payload: { body: string } }) => ({ body: event.payload.body }))).toEqual(retained);
	expect((await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()).traffic.frozen).toBe(false);
}, 60000);
