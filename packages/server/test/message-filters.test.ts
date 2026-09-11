import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("combines published message filters before pagination and keeps them across long-poll", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const first = await app.login(),
		second = await app.login();
	await app.ready(first);
	const read = (query: string) => fetch(`${app.url}/api/messages?${query}`, { headers: { cookie: first } });
	const query = async (extra: string) => {
		const response = await read(`since=0&${extra}`);
		expect(response.status).toBe(200);
		return response.json();
	};
	const create = async (topic: string, body: string, tags: string[], cookie = first) => {
		const response = await app.post("/api/messages", { topic, body, tags }, cookie);
		expect(response.status).toBe(200);
		return response.json();
	};
	await create("@pi", "café blue moon", ["answering"]);
	const one = await create("@pi", "café blue moon", ["answer", "odd'\"tag", ""]);
	await create("@pi-cloud", "café blue moon", ["answer"]);
	await create("@pi/child", "café blue distant moon", ["answer"]);
	const two = await create("@pi/child", "CAFÉ blue moon", ["answer"]);
	const filters = `topic=@pi&recursive=1&tag=answer&agent=rahul&q=${encodeURIComponent('cafe "blue moon"')}`;
	const page = await query(`${filters}&limit=1`);
	expect(page.items).toEqual([one]);
	const next = await (await read(`since=${page.cursor}&${filters}&limit=1`)).json();
	expect(next.items).toEqual([two]);
	expect(await (await read(`since=${next.cursor}&${filters}`)).json()).toEqual({
		items: [],
		cursor: two.seq,
		timed_out: false,
		drained: false,
	});
	expect((await query("topic=@pi&tag=answer")).items).toEqual([one]);
	expect((await query("tag=Answer")).items).toEqual([]);
	expect((await query("agent=missing")).items).toEqual([]);
	expect((await query(`tag=${encodeURIComponent("odd'\"tag")}`)).items).toEqual([one]);
	expect((await query("tag=")).items).toEqual([one]);
	for (const invalid of [
		"tag=a&tag=b",
		"agent=rahul&agent=missing",
		"q=a&q=b",
		"agent=",
		"agent=../bad",
		"q=",
		"q=%22unfinished",
		`tag=${"x".repeat(101)}`,
		`q=${"x".repeat(513)}`,
	])
		expect((await read(`since=0&${invalid}`)).status, invalid).toBe(400);
	const waiting = read(`since=${two.seq}&${filters}&wait=5`);
	await create("@pi", "cafe blue moon own", ["answer"]);
	await create("@pi", "cafe blue moon wrong tag", ["question"], second);
	const reply = await create("@pi/child", "cafe blue moon reply", ["answer"], second);
	expect((await (await waiting).json()).items).toEqual([reply]);
	expect((await fetch(`${app.url}/api/messages?tag=answer&q=cafe`)).status).toBe(401);
	const docs = await (await fetch(`${app.url}/api`, { headers: { cookie: first } })).json();
	expect(docs.paths["/api/messages"].get.parameters.map((parameter: { name: string }) => parameter.name)).toEqual(
		expect.arrayContaining(["tag", "agent", "q"]),
	);
}, 30000);
