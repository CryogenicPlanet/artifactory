import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("removes reaction routes while preserving historical rows across restart", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const read = (path: string) => fetch(`${app.url}${path}`, { headers: { cookie } });
	expect((await (await read("/api")).json()).paths).not.toHaveProperty("/api/reactions");
	expect((await read("/api/reactions?message=m_old")).status).toBe(404);
	expect((await app.post("/api/reactions", { message: "m_old", emoji: "+1" }, cookie)).status).toBe(404);
	await fixture.sql("INSERT INTO reactions VALUES('m_old','legacy','+1',1,0,42)");
	await fixture.sql("INSERT INTO reaction_idempotency VALUES('legacy','key','m_old','+1','{\"active\":true}')");
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(await fixture.sql("SELECT * FROM reactions")).toEqual([
		{ message_id: "m_old", instance: "legacy", emoji: "+1", active: 1, previous_active: 0, updated_seq: 42 },
	]);
	expect(await fixture.sql("SELECT outcome FROM reaction_idempotency")).toEqual([{ outcome: '{"active":true}' }]);
}, 30000);
