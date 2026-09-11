import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("decodes bounded numeric queries while preserving omitted cursors and schema errors", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string) => fetch(app.url + path, { headers: { cookie } });
	const message = await (
		await app.post("/api/messages", { topic: "numbers/child", body: "numeric boundary" }, cookie)
	).json();
	const omitted = await (await get("/api/messages?mark=0")).json();
	expect(omitted).toMatchObject({ items: [], timed_out: false, drained: false });
	expect(omitted.cursor).toBeGreaterThanOrEqual(message.seq);
	const history = await (await get("/api/messages?since=0&limit=1&wait=0&mark=0")).json();
	expect(history.items).toEqual([message]);
	const newest = await (await get("/api/messages?newest=1&limit=200&mark=0")).json();
	expect(newest.items).toEqual([message]);
	for (const depth of ["", "?depth=1", "?depth=200"])
		expect((await get(`/api/topics/numbers${depth}`)).status).toBe(200);

	const invalid = ["", "-1", "1.5", "1e1", "0x10", "NaN", "Infinity", " 1", "1 ", "+1", "9007199254740992"];
	for (const [path, names] of [
		["/api/messages", ["since", "limit", "wait"]],
		["/api/stream", ["since", "limit"]],
		["/api/topics/numbers", ["depth"]],
	] as const) {
		for (const name of names) {
			for (const value of invalid) {
				const query = `${name}=${encodeURIComponent(value)}`;
				const response = await get(`${path}?${query}`);
				expect(response.status, `${path}?${query}`).toBe(400);
				expect(await response.json()).toMatchObject({ error: { code: "query_invalid", retriable: false } });
			}
			const duplicate = await get(`${path}?${name}=1&${name}=1`);
			expect(duplicate.status).toBe(400);
			expect(await duplicate.json()).toMatchObject({ error: { code: "query_invalid" } });
		}
	}
	for (const path of [
		"/api/messages?limit=0",
		"/api/messages?limit=201",
		"/api/messages?wait=61",
		"/api/messages?newest=1&wait=1",
		"/api/messages?since=0&unknown=1",
		"/api/stream?limit=0",
		"/api/stream?limit=201",
		"/api/topics/numbers?depth=0",
		"/api/topics/numbers?depth=201",
	]) {
		const response = await get(path);
		expect(response.status, path).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "query_invalid", retriable: false } });
	}
	const ahead = await get(`/api/messages?since=${Number.MAX_SAFE_INTEGER}`);
	expect(ahead.status).toBe(400);
	expect(await ahead.json()).toMatchObject({ error: { code: "cursor_ahead" } });

	const invalidHeader = await fetch(`${app.url}/api/stream`, { headers: { cookie, "last-event-id": "1e1" } });
	expect(invalidHeader.status).toBe(400);
	expect(await invalidHeader.json()).toMatchObject({ error: { code: "query_invalid" } });
	const controller = new AbortController();
	test.onTestFinished(() => controller.abort());
	const override = await fetch(`${app.url}/api/stream?since=0&limit=1`, {
		headers: { cookie, "last-event-id": "invalid-but-overridden" },
		signal: controller.signal,
	});
	expect(override.status).toBe(200);
	controller.abort();

	const api = await (await get("/api")).json();
	for (const [path, name, minimum, maximum] of [
		["/api/messages", "since", 0, Number.MAX_SAFE_INTEGER],
		["/api/messages", "limit", 1, 200],
		["/api/messages", "wait", 0, 60],
		["/api/stream", "since", 0, Number.MAX_SAFE_INTEGER],
		["/api/stream", "limit", 1, 200],
		["/api/topics/{*}", "depth", 1, 200],
	] as const)
		expect(api.paths[path].get.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name,
					required: false,
					schema: expect.objectContaining({
						type: "string",
						allOf: expect.arrayContaining([
							expect.objectContaining({
								pattern: "^[0-9]+$",
								contentSchema: { type: "integer", minimum, maximum },
							}),
						]),
					}),
				}),
			]),
		);
}, 30000);
