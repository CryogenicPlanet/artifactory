import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("searches Unicode words and phrases across topic boundaries with cursor, edits, deletion and read authorization", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const read = (query: string) => fetch(`${app.url}/api/messages?recursive=1&${query}`, { headers: { cookie } });
	const search = async (q: string, extra = "") => {
		const response = await read(`q=${encodeURIComponent(q)}${extra.includes("since=") ? "" : "&since=0"}${extra}`);
		expect(response.status).toBe(200);
		return response.json();
	};
	expect((await fetch(`${app.url}/api/messages?q=hello`)).status).toBe(401);
	const records = [];
	for (const [topic, body] of [
		["@pi", "Café launch blue moon"],
		["@pi/child", "Launch café blue distant moon"],
		["@pi-cloud", "Café launch blue moon"],
	]) {
		const response = await app.post("/api/messages", { topic, body }, cookie);
		expect(response.status).toBe(200);
		records.push(await response.json());
	}
	const first = await search("CAFE launch", "&topic=@pi&limit=1");
	expect(first.items).toEqual([records[0]]);
	expect(first.cursor).toBe(records[0].seq);
	const second = await search("cafe", `&topic=@pi&since=${first.cursor}&limit=1`);
	expect(second.items).toEqual([records[1]]);
	expect(await search("cafe", `&topic=@pi&since=${second.cursor}`)).toEqual({
		items: [],
		cursor: expect.any(Number),
		timed_out: false,
		drained: false,
	});
	expect((await search('"blue moon"', "&topic=@pi")).items).toEqual([records[0]]);
	expect((await search("launch OR missing")).items).toEqual([]);
	expect((await search("launch' OR 1=1")).items).toEqual([]);
	for (const query of [
		"q=",
		"q=%22unfinished",
		"q=%25",
		"q=abc%00def",
		"q=hi&limit=0",
		"q=hi&limit=201",
		"q=hi&since=-1",
		"q=hi&topic=../bad",
		"q=hi&wat=1",
		"q=hi&q=bye",
		`q=${"a".repeat(513)}`,
		`q=${Array(17).fill("word").join("+")}`,
	])
		expect((await read(query)).status, query).toBe(400);
	const mutate = (method: string, id: string, body?: unknown) =>
		fetch(`${app.url}/api/messages/${id}`, {
			method,
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	expect((await mutate("PATCH", records[0].id, { body: "renamed nebula" })).status).toBe(200);
	expect((await search("cafe", "&topic=@pi")).items).toEqual([records[1]]);
	expect((await search("nebula")).items[0]).toMatchObject({
		id: records[0].id,
		seq: records[0].seq,
		body: "renamed nebula",
	});
	expect((await mutate("DELETE", records[1].id)).status).toBe(200);
	expect((await search("cafe", "&topic=@pi")).items).toEqual([]);
	await fixture.sql("UPDATE topics SET archived_at=1 WHERE path='@pi'");
	expect((await search("nebula", "&topic=@pi")).items).toHaveLength(1);
	const enrolled = await (await app.post("/auth/enroll", { name: "limited", kind: "test", host: "search" })).json();
	const params = { id: enrolled.id, decision: "approve" as const, scopes: ["write"], long_lived: false };
	const proof = await app.assertion(params);
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrolled.id}/approve`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://comms.test", "x-chirp-assertion": proof },
				body: JSON.stringify({ decision: params.decision, scopes: params.scopes, long_lived: params.long_lived }),
			})
		).status,
	).toBe(200);
	const pair = await (await app.post(`/auth/enroll/${enrolled.id}`, { device_secret: enrolled.device_secret })).json();
	expect(
		(await fetch(`${app.url}/api/messages?q=nebula`, { headers: { authorization: `Bearer ${pair.access}` } })).status,
	).toBe(403);
	expect(
		(await (await fetch(`${app.url}/api`, { headers: { cookie } })).json()).paths["/api/messages"].get.description,
	).toBeTruthy();
}, 30000);
