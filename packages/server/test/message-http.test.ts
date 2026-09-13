import { agentHeader, assertionHeader, authKindHeader } from "@comms/protocol/headers";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("edits and soft-deletes by author instance or human, preserving attribution, cursors and original retry outcomes", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const grant = async (scopes: readonly string[]) => {
		const enrollment = await (
			await app.post("/auth/enroll", { name: "codex", kind: "codex", host: "same-label" })
		).json();
		const params = { id: enrollment.id, decision: "approve" as const, scopes, long_lived: false };
		const proof = await app.assertion(params);
		expect(
			(
				await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
					method: "POST",
					headers: { origin: "https://comms.test", "content-type": "application/json", [assertionHeader]: proof },
					body: JSON.stringify({ decision: "approve", scopes, long_lived: false }),
				})
			).status,
		).toBe(200);
		return (await (await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })).json())
			.access;
	};
	const owner = await grant(["read", "write"]),
		sibling = await grant(["read", "write"]),
		reader = await grant(["read"]);
	const call = (method: string, path: string, access: string, body?: unknown, key?: string) =>
		fetch(app.url + path, {
			method,
			headers: {
				authorization: `Bearer ${access}`,
				"content-type": "application/json",
				[authKindHeader]: "human",
				[agentHeader]: "rahul",
				...(key ? { "idempotency-key": key } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const input = { topic: "@codex/task", body: "Original", tags: ["question"], meta: { pinned: true } };
	const created = await (await call("POST", "/api/messages", owner, input, "create")).json();
	const path = `/api/messages/${created.id}`;
	const one = async (seq: number, access: string, topic = input.topic) =>
		(await (await call("GET", `/api/messages?since=${seq - 1}&limit=1&topic=${topic}`, access)).json()).items[0];
	expect(await one(created.seq, reader)).toEqual(created);
	for (const access of [sibling, reader]) {
		expect((await call("PATCH", path, access, { body: "Denied" })).status).toBe(403);
		const deniedDelete = await call("DELETE", path, access);
		expect(deniedDelete.status, await deniedDelete.text()).toBe(403);
	}
	for (const body of [
		{},
		{ body: "" },
		{ body: "a".repeat(65537) },
		{ agent: "rahul" },
		{ topic: "moved" },
		{ body: "valid", seq: 42 },
	])
		expect((await call("PATCH", path, owner, body)).status).toBe(400);
	const patch = { body: "Edited", tags: [], meta: { status: "answered" } };
	const edited = await (await call("PATCH", path, owner, patch, "edit")).json();
	expect(edited).toMatchObject({ ...created, ...patch, edited_at: expect.any(Number) });
	expect(await one(created.seq, reader)).toEqual(edited);
	expect(await (await call("POST", "/api/messages", owner, input, "create")).json()).toEqual(created);
	expect((await call("PATCH", path, owner, { body: "different" }, "edit")).status).toBe(409);
	const human = await fetch(app.url + path, {
		method: "PATCH",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
		body: JSON.stringify({ body: "Human correction" }),
	});
	expect(human.status).toBe(200);
	expect(await human.json()).toMatchObject({
		agent: created.agent,
		instance: created.instance,
		seq: created.seq,
		body: "Human correction",
	});
	expect(await (await call("PATCH", path, owner, patch, "edit")).json()).toEqual(edited);
	const deleted = await (await call("DELETE", path, owner, undefined, "delete")).json();
	expect(deleted).toMatchObject({ id: created.id, seq: created.seq, deleted_at: expect.any(Number) });
	expect(await (await call("DELETE", path, owner, undefined, "delete")).json()).toEqual(deleted);
	expect(await (await call("DELETE", path, owner)).json()).toEqual(deleted);
	expect(await one(created.seq, reader)).toBeUndefined();
	expect((await call("PATCH", path, owner, { body: "Resurrect" })).status).toBe(404);
	expect(await (await call("POST", "/api/messages", owner, input, "create")).json()).toEqual(created);
	for (const list of ["/api/messages?since=0&topic=@codex/task"])
		expect((await (await call("GET", list, sibling)).json()).items).toEqual([]);
	const topic = await (await call("GET", "/api/topics/@codex/task", reader)).json();
	expect(topic).toMatchObject({ path: "@codex/task", messages: [], unread: 0 });
	const events = await (await call("GET", "/api/events?since=0&types=message.*&topic=@codex/task", owner)).json();
	expect(events.items.map((event: { type: string }) => event.type)).toEqual([
		"message.created",
		"message.edited",
		"message.edited",
		"message.deleted",
	]);
	expect(events.items[1].payload).toEqual(edited);
	expect(events.items[2]).toMatchObject({ actor: "rahul", payload: { agent: "codex", instance: created.instance } });
	expect(events.items[1].seq).toBeGreaterThan(created.seq);
	expect(events.items[3].payload).toEqual(deleted);
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM messages WHERE deleted_at IS NOT NULL")).toEqual([
		{ count: 1 },
	]);
	const retained = await (
		await call("POST", "/api/messages", owner, { topic: "archived/child", body: "Retained" })
	).json();
	expect(await (await call("DELETE", path, owner, undefined, "already-deleted")).json()).toEqual(deleted);
	expect((await call("DELETE", `/api/messages/${retained.id}`, owner, undefined, "already-deleted")).status).toBe(409);
	await fixture.sql("UPDATE topics SET archived_at=1 WHERE path='archived'");
	for (const method of ["PATCH", "DELETE"])
		expect(
			(
				await call(
					method,
					`/api/messages/${retained.id}`,
					owner,
					method === "PATCH" ? { body: "Forbidden" } : undefined,
				)
			).status,
		).toBe(409);
	expect((await call("POST", "/api/messages", owner, { topic: "archived/child/deep", body: "Forbidden" })).status).toBe(
		409,
	);
	expect(await one(retained.seq, reader, retained.topic)).toEqual(retained);
	await fixture.sql("UPDATE kernel_writer SET epoch='replaced'");
	expect((await call("PATCH", `/api/messages/${retained.id}`, owner, { body: "Forbidden stale writer" })).status).toBe(
		503,
	);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='archived/child'")).toEqual([{ body: "Retained" }]);
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(
		(await (await fetch(resumed.url + "/api/messages?since=0&topic=@codex/task", { headers: { cookie } })).json())
			.items,
	).toEqual([]);
}, 30000);
