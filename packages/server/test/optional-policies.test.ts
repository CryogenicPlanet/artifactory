import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("loads optional profile, roster and deletion policies through public capabilities with durable retries", async (test) => {
	const fixture = await conversation(test),
		seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	for (const name of ["roster", "topic-delete"])
		await cp(join(import.meta.dirname, `../../../examples/extensions/${name}.ts`), join(seed, `ext/${name}.ts`));
	await writeFile(
		join(seed, "ext/roster-replay.ts"),
		`import {Effect} from "effect"; import {observeRequest} from "./roster.ts";
 export default api=>api.route("POST","/api/roster-replay",{description:"Fixture replays observed diagnostic",scope:"write",handler:(_request,ctx)=>Effect.gen(function*(){
 const rows=yield* ctx.read(()=>ctx.db\`SELECT * FROM example_roster WHERE instance=\${ctx.instance}\`); const row=rows[0]; if(!row) return new Response(null,{status:409});
 const event={seq:row.source_seq,at:row.last_observed_at-1,type:"http.request",level:"info",actor:ctx.agent,instance:ctx.instance,generation:ctx.generation,request_id:ctx.request,topic:null,message_id:null,payload:{secret:"must-not-copy"}};
 yield* observeRequest({...ctx,event}); yield* observeRequest({...ctx,event:{...event,seq:event.seq-1}});
 const after=yield* ctx.read(()=>ctx.db\`SELECT * FROM example_roster WHERE instance=\${ctx.instance}\`); return Response.json({before:row,after:after[0]}); })});`,
	);
	let app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const enroll = async (host: string, scopes: string[]) => {
		const enrolled = await (await app.post("/auth/enroll", { name: "optional-agent", kind: "codex", host })).json();
		const params = { id: enrolled.id, decision: "approve" as const, scopes, long_lived: false };
		const proof = await app.assertion(params);
		expect(
			(
				await fetch(`${app.url}/_boot/enroll/${enrolled.id}/approve`, {
					method: "POST",
					headers: { origin: "https://comms.test", "content-type": "application/json", "x-comms-assertion": proof },
					body: JSON.stringify({ decision: "approve", scopes, long_lived: false }),
				})
			).status,
		).toBe(200);
		return (await (await app.post(`/auth/enroll/${enrolled.id}`, { device_secret: enrolled.device_secret })).json())
			.access;
	};
	const first = await enroll("first", ["read", "write"]),
		sibling = await enroll("sibling", ["read", "write"]),
		reader = await enroll("reader", ["read"]);
	const call = (path: string, method: string, token: string, body?: unknown, key?: string) =>
		fetch(app.url + path, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				...(key ? { "idempotency-key": key } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	expect((await fetch(app.url + "/api/agents")).status).toBe(401);
	expect((await call("/api/me", "PATCH", reader, { status: "blocked" })).status).toBe(403);
	expect((await call("/api/me", "PATCH", first, { agent: "other" })).status).toBe(400);
	const oversized = await fetch(app.url + "/api/me", {
		method: "PATCH",
		headers: { authorization: `Bearer ${first}`, "content-type": "application/json" },
		body: " ".repeat(4096) + JSON.stringify({ status: "valid but oversized" }),
	});
	expect(oversized.status).toBe(400);
	const missing = await call("/api/topics/never-created", "DELETE", first);
	expect(missing.status).toBe(404);
	expect(await missing.json()).toMatchObject({ error: { code: "topic_not_found", retriable: false } });
	const changed = await call(
		"/api/me",
		"PATCH",
		first,
		{ emoji: "🌱", status: "working", color: "#123456" },
		"profile",
	);
	expect(changed.status).toBe(200);
	const profile = await changed.json();
	expect(
		await (
			await call("/api/me", "PATCH", first, { emoji: "🌱", status: "working", color: "#123456" }, "profile")
		).json(),
	).toEqual(profile);
	expect((await call("/api/me", "PATCH", first, { status: "different" }, "profile")).status).toBe(409);
	const posted = await call("/api/messages", "POST", first, { topic: "optional/child", body: "retained" });
	expect(posted.status).toBe(200);
	const message = await posted.json();
	const firstIdentity = await (await call("/api/me", "GET", first)).json();
	const readerIdentity = await (await call("/api/me", "GET", reader)).json();
	await expect
		.poll(async () => (await (await call("/api/agents", "GET", reader)).json()).items, { timeout: 5000 })
		.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ instance: firstIdentity.instance }),
				expect.objectContaining({
					agent: "optional-agent",
					instance: readerIdentity.instance,
					last_observed_at: expect.any(Number),
					profile: { emoji: "🌱", status: "working", color: "#123456" },
				}),
			]),
		);
	const roster = await (await call("/api/agents", "GET", reader)).json();
	for (const item of roster.items)
		expect(Object.keys(item).sort()).toEqual(["agent", "instance", "last_observed_at", "profile"]);
	for (const secret of [first, sibling, reader, cookie]) expect(JSON.stringify(roster)).not.toContain(secret);
	const replayResponse = await call("/api/roster-replay", "POST", first, {});
	expect(replayResponse.status).toBe(200);
	const replay = await replayResponse.json();
	expect(replay.after).toEqual(replay.before);
	expect(JSON.stringify(replay)).not.toContain("must-not-copy");
	await mkdir(join(fixture.root, "pages/page-only"), { recursive: true });
	await writeFile(join(fixture.root, "pages/page-only/index.md"), "retained page");
	expect((await call("/api/topics/page-only", "DELETE", first)).status).toBe(403);
	const humanDelete = () =>
		fetch(app.url + "/api/topics/page-only", {
			method: "DELETE",
			headers: { cookie, origin: "https://comms.test", "idempotency-key": "page-delete" },
		});
	const pageDeleted = await (await humanDelete()).json();
	expect(pageDeleted).toMatchObject({ path: "page-only", seq: expect.any(Number) });
	expect(await (await humanDelete()).json()).toEqual(pageDeleted);

	expect((await call("/api/topics/optional", "DELETE", reader)).status).toBe(403);
	expect((await call("/api/topics/optional", "DELETE", sibling)).status).toBe(403);
	const deletion = await call("/api/topics/optional", "DELETE", first, undefined, "delete");
	expect(deletion.status).toBe(200);
	const deleted = await deletion.json();
	expect(await (await call("/api/topics/optional", "DELETE", first, undefined, "delete")).json()).toEqual(deleted);
	expect((await call("/api/topics/optional", "GET", first)).status).toBe(404);
	expect(await fixture.sql(`SELECT id FROM messages WHERE id='${message.id}'`)).toEqual([{ id: message.id }]);
	await app.stop();
	app = await fixture.launch(join(seed, "server.ts"));
	await app.ready(cookie);
	expect(await (await call("/api/topics/optional", "DELETE", first, undefined, "delete")).json()).toEqual(deleted);
	expect(
		await (
			await call("/api/me", "PATCH", first, { emoji: "🌱", status: "working", color: "#123456" }, "profile")
		).json(),
	).toEqual(profile);
	expect(await fixture.sql("SELECT count(*) AS count FROM events WHERE type='topic.deleted'", "boot.db")).toEqual([
		{ count: 2 },
	]);
	expect(await fixture.sql("SELECT count(*) AS count FROM events WHERE type='profile.updated'", "boot.db")).toEqual([
		{ count: 1 },
	]);
}, 45000);
