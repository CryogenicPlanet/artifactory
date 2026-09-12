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
	await fixture.sql("DELETE FROM core_migrations WHERE migration_id>=10");
	await fixture.sql("PRAGMA user_version=1");
	const before = await fixture.sql("SELECT migration_id,name FROM core_migrations ORDER BY migration_id");
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(await fixture.sql("PRAGMA user_version")).toEqual([{ user_version: 12 }]);
	expect(
		await fixture.sql("SELECT migration_id,name FROM core_migrations WHERE migration_id<10 ORDER BY migration_id"),
	).toEqual(before);
	expect(await fixture.sql("SELECT body,mentions FROM messages WHERE topic='ledger'")).toEqual([
		{ body: input.body, mentions: '["@codex"]' },
	]);
	expect(await (await resumed.post("/api/messages", input, cookie, "retained")).json()).toEqual(outcome);
}, 30000);

it("advances SQLite core ten without rewriting encoded domain values or retry receipts", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const input = { topic: "json-upgrade", body: "retained" };
	const response = await app.post("/api/messages", input, cookie, "json-upgrade");
	expect(response.status).toBe(200);
	const outcome: unknown = await response.json();
	await app.stop();
	await fixture.sql(
		`UPDATE messages SET tags='[ "one", "雪" ]',meta='{ "nested": { "nil": null } }',previous='{ "body": "prior" }' WHERE topic='json-upgrade'`,
	);
	const before = await fixture.sql("SELECT * FROM messages WHERE topic='json-upgrade'");
	await fixture.sql("DELETE FROM core_migrations WHERE migration_id>=11");
	await fixture.sql("PRAGMA user_version=10");
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(await fixture.sql("SELECT * FROM messages WHERE topic='json-upgrade'")).toEqual(before);
	expect(await fixture.sql("PRAGMA user_version")).toEqual([{ user_version: 12 }]);
	expect(await fixture.sql("SELECT name FROM core_migrations WHERE migration_id=11")).toEqual([
		{ name: "domain_json" },
	]);
	expect(await (await resumed.post("/api/messages", input, cookie, "json-upgrade")).json()).toEqual(outcome);
}, 30000);
