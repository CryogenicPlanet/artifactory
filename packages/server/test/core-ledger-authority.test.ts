import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("uses the recorded core prefix for conditional upgrades when its mirror lags", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const input = { topic: "ledger", body: "**@codex**" };
	const response = await app.post("/api/messages", input, cookie, "retained");
	expect(response.status).toBe(200);
	const outcome: unknown = await response.json();
	await app.stop();
	await fixture.sql("UPDATE messages SET mentions='[\"@codex.\"]' WHERE topic='ledger'");
	// Rung ten must run as an upgrade from nine, not from the obsolete mirror.
	await fixture.sql("DELETE FROM core_migrations WHERE migration_id=10");
	await fixture.sql("PRAGMA user_version=1");
	const before = await fixture.sql("SELECT migration_id,name FROM core_migrations ORDER BY migration_id");
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(await fixture.sql("PRAGMA user_version")).toEqual([{ user_version: 10 }]);
	expect(
		await fixture.sql("SELECT migration_id,name FROM core_migrations WHERE migration_id<10 ORDER BY migration_id"),
	).toEqual(before);
	expect(await fixture.sql("SELECT body,mentions FROM messages WHERE topic='ledger'")).toEqual([
		{ body: input.body, mentions: '["@codex"]' },
	]);
	expect(await (await resumed.post("/api/messages", input, cookie, "retained")).json()).toEqual(outcome);
}, 30000);
