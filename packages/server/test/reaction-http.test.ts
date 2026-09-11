import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";
it("toggles per verified instance, replays safely, rejects invalid targets and retains state after restart", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login(),
		sibling = await app.login();
	await app.ready(cookie);
	const created = await (
		await app.post("/api/messages", { topic: "reaction/thread", body: "React here" }, cookie)
	).json();
	const input = { message: created.id, emoji: "👍🏽" };
	expect((await app.post("/api/reactions", input)).status).toBe(401);
	const first = await (await app.post("/api/reactions", input, cookie, "toggle")).json();
	expect(first).toMatchObject({ ...input, active: true, instance: expect.any(String), seq: expect.any(Number) });
	const simultaneous = await Promise.all([
		app.post("/api/reactions", input, cookie, "toggle"),
		app.post("/api/reactions", input, cookie, "toggle"),
	]);
	for (const response of simultaneous) expect(await response.json()).toEqual(first);
	const second = await (await app.post("/api/reactions", input, sibling, "toggle")).json();
	expect(second.active).toBe(true);
	expect(second.instance).not.toBe(first.instance);
	const list = () =>
		fetch(`${app.url}/api/reactions?message=${created.id}`, { headers: { cookie } }).then((r) => r.json());
	expect((await list()).items).toHaveLength(2);
	expect((await app.post("/api/reactions", { ...input, emoji: "❤️" }, cookie, "toggle")).status).toBe(409);
	const removed = await (await app.post("/api/reactions", input, cookie, "remove")).json();
	expect(removed.active).toBe(false);
	expect(removed.seq).toBeGreaterThan(second.seq);
	expect(await (await app.post("/api/reactions", input, cookie, "toggle")).json()).toEqual(first);
	expect((await list()).items).toEqual([{ instance: second.instance, emoji: input.emoji }]);
	for (const invalid of ["", "has space", "\n", "x".repeat(65)])
		expect((await app.post("/api/reactions", { ...input, emoji: invalid }, cookie)).status).toBe(400);
	expect((await app.post("/api/reactions", { ...input, instance: first.instance }, cookie)).status).toBe(400);
	const enrollment = await (await app.post("/auth/enroll", { name: "codex", kind: "codex", host: "reader" })).json();
	const scopes = ["read"],
		proof = await app.assertion({ id: enrollment.id, decision: "approve", scopes, long_lived: false });
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", "x-comms-assertion": proof },
				body: JSON.stringify({ decision: "approve", scopes, long_lived: false }),
			})
		).status,
	).toBe(200);
	const access = (
		await (await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })).json()
	).access;
	expect(
		(
			await fetch(`${app.url}/api/reactions`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${access}`,
					"content-type": "application/json",
					"x-comms-scopes": "read,write",
					"x-comms-auth-kind": "human",
				},
				body: JSON.stringify(input),
			})
		).status,
	).toBe(403);
	await fixture.sql("UPDATE topics SET archived_at=1 WHERE path='reaction'");
	expect((await app.post("/api/reactions", input, cookie)).status).toBe(409);
	expect((await list()).items).toHaveLength(1);
	await fixture.sql("UPDATE topics SET archived_at=NULL WHERE path='reaction'");
	const deleted = await (
		await app.post("/api/messages", { topic: "reaction/thread", body: "Delete this" }, cookie)
	).json();
	expect(
		(
			await fetch(`${app.url}/api/messages/${deleted.id}`, {
				method: "DELETE",
				headers: { cookie, origin: "https://comms.test" },
			})
		).status,
	).toBe(200);
	expect((await app.post("/api/reactions", { ...input, message: deleted.id }, cookie)).status).toBe(404);
	const events = await (await fetch(`${app.url}/api/events?since=0&types=reaction.*`, { headers: { cookie } })).json();
	expect(events.items.map((event: { payload: unknown }) => event.payload)).toEqual([first, second, removed]);
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(
		(await (await fetch(`${resumed.url}/api/reactions?message=${created.id}`, { headers: { cookie } })).json()).items,
	).toEqual([{ instance: second.instance, emoji: input.emoji }]);
	expect(await (await resumed.post("/api/reactions", input, cookie, "toggle")).json()).toEqual(first);
}, 30000);
