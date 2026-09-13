import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mentionsIn } from "../src/ext/core/message-mentions.ts";
import { conversation } from "./fixtures/conversation.ts";

it("recognizes punctuation-terminated mentions without shortening another valid target", () => {
	for (const [body, target] of [
		["**@codex**", "@codex"],
		["~~@codex~~", "@codex"],
		["`@codex`", "@codex"],
		["<@codex>", "@codex"],
		["😀@codex😀", "@codex"],
		['"@codex"', "@codex"],
		["_@codex_", "@codex"],
		["|@codex|", "@codex"],
		["over to @codex.", "@codex"],
		["over to @codex, thanks", "@codex"],
		["over to @codex!", "@codex"],
		["over to @codex/job-17.", "@codex/job-17"],
		["over to @codex-", "@codex"],
		["over to @codex_", "@codex"],
		["over to @codex.other", "@codex.other"],
		["instance @codex/mac here", "@codex/mac"],
	])
		expect(mentionsIn(body ?? "")).toEqual([target]);
	for (const body of [
		"mailto:@codex",
		"https://example.test/@codex",
		"/@codex",
		"x@codex",
		"é@codex",
		"x\u0301@codex",
		"@@codex",
		"@codexX",
		"@codexé",
		"@codex/",
		"@codex//job",
		"@codex.otherX",
		"@codex.otheré",
		"@codex-jobX",
		// A handle with more path after it is the common shape: raw file URLs and profile links.
		"https://raw.githubusercontent.com/@codex/repo/main/README.md",
		"rahul@codex.com",
	])
		expect(mentionsIn(body)).toEqual([]);
	// An agent and one of its instances stay distinct targets in the same body.
	expect(mentionsIn("@codex and @codex/mac")).toEqual(["@codex", "@codex/mac"]);
});

it("marks only the requested subtree in OR results and never globally marks a mentions-only view", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login(),
		author = await app.login();
	await app.ready(cookie);
	const post = async (topic: string, body: string) => {
		const response = await app.post("/api/messages", { topic, body }, author);
		expect(response.status).toBe(200);
		return response.json();
	};
	const home = await post("@codex/job", "home");
	const unseen = await post("@codex/job", "unseen");
	const outside = await post("@codex-other", "over to @codex.");
	const get = async (query: string) => {
		const response = await fetch(`${app.url}/api/messages?${query}`, { headers: { cookie } });
		expect(response.status, await response.clone().text()).toBe(200);
		return response.json();
	};
	expect((await get("since=0&mentions=@codex")).items).toEqual([outside]);
	expect(await fixture.sql("SELECT topic,seq FROM reads")).toEqual([]);
	// The tag filter returns one home row and a newer outside mention, leaving unseen home data.
	const tagged = await fetch(`${app.url}/api/messages/${home.seq}`, {
		method: "PATCH",
		headers: { cookie: author, origin: "https://comms.test", "content-type": "application/json" },
		body: JSON.stringify({ tags: ["selected"] }),
	});
	expect(tagged.status).toBe(200);
	const taggedOutside = await fetch(`${app.url}/api/messages/${outside.seq}`, {
		method: "PATCH",
		headers: { cookie: author, origin: "https://comms.test", "content-type": "application/json" },
		body: JSON.stringify({ tags: ["selected"] }),
	});
	expect(taggedOutside.status).toBe(200);
	for (const query of [
		"since=0&q=home&limit=1",
		"since=0&tag=selected",
		`since=0&agent=${home.agent}`,
		"newest=1&limit=1",
	]) {
		expect((await get(query)).items.length).toBeGreaterThan(0);
		expect(await fixture.sql("SELECT topic,seq FROM reads")).toEqual([]);
	}
	const root = await fetch(`${app.url}/api/topics`, { headers: { cookie } });
	expect(root.status).toBe(200);
	expect((await root.json()).messages.length).toBeGreaterThan(0);
	expect(await fixture.sql("SELECT topic,seq FROM reads")).toEqual([]);
	const query = "since=0&topic=@codex&recursive=1&mentions=@codex&tag=selected";
	expect((await get(query + "&mark=0")).items.map((message: { seq: number }) => message.seq)).toEqual([
		home.seq,
		outside.seq,
	]);
	expect(await fixture.sql("SELECT topic,seq FROM reads")).toEqual([]);
	await get(query);
	expect(await fixture.sql("SELECT topic,seq FROM reads")).toEqual([{ topic: "@codex", seq: home.seq }]);
	expect(unseen.seq).toBeGreaterThan(home.seq);
	const topic = await fetch(`${app.url}/api/topics/@codex/job?mark=0`, { headers: { cookie } });
	expect(topic.status).toBe(200);
	expect((await topic.json()).unread).toBe(1);
}, 30000);

it("reindexes both historical mention images on upgrade without changing messages or retry outcomes", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const input = { topic: "history", body: "**@codex**" };
	const original = await (await app.post("/api/messages", input, cookie, "historical-mention")).json();
	// More than one migration page, using real published messages and their normal identities.
	for (let index = 0; index < 256; index++) {
		const response = await app.post(
			"/api/messages",
			{ topic: "history-pages", body: `item ${index} |@alice|` },
			cookie,
		);
		expect(response.status).toBe(200);
	}
	await app.stop();
	await fixture.sql("UPDATE messages SET mentions='[\"@alice.\"]' WHERE topic='history-pages'");
	await fixture.sql(
		"UPDATE messages SET mentions='[\"@codex.\"]',previous=json_object('body','previous _@alice/job_'),previous_mentions='[\"@alice/job.\"]' WHERE topic='history'",
	);
	const history = await fixture.sql(
		"SELECT id,seq,topic,agent,instance,body,tags,meta,created_at,edited_at,deleted_at,updated_seq,previous FROM messages WHERE topic='history'",
	);
	const receipts = await fixture.sql(
		"SELECT * FROM idempotency WHERE json_extract(key,'$[1]')='historical-mention' ORDER BY instance,key",
	);
	// Preserve legacy root marks rather than guessing which old reads were accidental.
	await fixture.sql("INSERT INTO reads(instance,topic,seq) VALUES('legacy-instance','',1)");
	const marks = await fixture.sql("SELECT * FROM reads ORDER BY instance,topic");
	await fixture.sql("DROP TABLE IF EXISTS core_migrations");
	await fixture.sql("PRAGMA user_version=9");
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(await fixture.sql("PRAGMA user_version")).toEqual([{ user_version: 10 }]);
	expect(await fixture.sql("SELECT * FROM reads ORDER BY instance,topic")).toEqual(marks);
	expect(
		await fixture.sql("SELECT COUNT(*) AS count FROM messages WHERE topic='history-pages' AND mentions='[\"@alice\"]'"),
	).toEqual([{ count: 256 }]);
	expect(await fixture.sql("SELECT mentions,previous_mentions FROM messages WHERE topic='history'")).toEqual([
		{ mentions: '["@codex"]', previous_mentions: '["@alice/job"]' },
	]);
	expect(
		await fixture.sql(
			"SELECT id,seq,topic,agent,instance,body,tags,meta,created_at,edited_at,deleted_at,updated_seq,previous FROM messages WHERE topic='history'",
		),
	).toEqual(history);
	expect(
		await fixture.sql(
			"SELECT * FROM idempotency WHERE json_extract(key,'$[1]')='historical-mention' ORDER BY instance,key",
		),
	).toEqual(receipts);
	expect(await (await resumed.post("/api/messages", input, cookie, "historical-mention")).json()).toEqual(original);
}, 30000);

it("leaves root read marks untouched when an extension calls markRead", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/root-read.ts"),
		`import {Effect} from "effect";
 export default api => api.route("GET","/api/root-read",{description:"Exercise empty-root read marks",scope:"read",handler:(_request,ctx)=>Effect.gen(function*(){yield* ctx.topics.markRead("",0);return Response.json({ok:true});})});`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await fetch(app.url + "/api/root-read", { headers: { cookie } })).status).toBe(200);
	expect(await fixture.sql("SELECT * FROM reads")).toEqual([]);
});
it("leaves the read mark alone on a latest-N read and still advances it on a forward read", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login(),
		author = await app.login();
	await app.ready(cookie);
	const post = async (body: string) => {
		const response = await app.post("/api/messages", { topic: "latest", body }, author);
		expect(response.status).toBe(200);
		return (await response.json()) as { readonly seq: number };
	};
	const get = async (query: string) => {
		const response = await fetch(`${app.url}/api/messages?${query}`, { headers: { cookie } });
		expect(response.status, await response.clone().text()).toBe(200);
		return (await response.json()) as { readonly items: ReadonlyArray<{ readonly seq: number }> };
	};
	const marks = () => fixture.sql("SELECT topic,seq FROM reads");
	const first = await post("first");
	await post("second");
	const third = await post("third");
	// One message returned, three unread: marking through it would clear two nobody saw.
	expect((await get("topic=latest&newest=1&limit=1")).items.map((item) => item.seq)).toEqual([third.seq]);
	expect(await marks()).toEqual([]);
	expect((await get(`topic=latest&since=0&limit=1`)).items.map((item) => item.seq)).toEqual([first.seq]);
	expect(await marks()).toEqual([{ topic: "latest", seq: first.seq }]);
	// A later newest read must not drag the mark forward over the messages it skipped.
	expect((await get("topic=latest&newest=1&limit=1")).items.map((item) => item.seq)).toEqual([third.seq]);
	expect(await marks()).toEqual([{ topic: "latest", seq: first.seq }]);
	const topic = await fetch(`${app.url}/api/topics/latest?mark=0`, { headers: { cookie } });
	expect(topic.status).toBe(200);
	expect((await topic.json()).unread).toBe(2);
}, 30000);
