import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "../fixtures/conversation.ts";

const rows = Schema.Array(Schema.Struct({ body: Schema.String, meta: Schema.String }));

it("mirrors retained operational events, retries a lost checkpoint without duplicate messages, and resumes after restart", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "system-seed");
	await cp(join(import.meta.dirname, "../../src"), seed, { recursive: true });
	await writeFile(join(seed, "ext/broken.ts"), 'export default () => { throw Error("private diagnostic payload"); };');
	await writeFile(
		join(seed, "ext/event-source.ts"),
		`import {Effect} from "effect";
export default api => api.route("POST","/api/test-events",{description:"Publish test diagnostics",scope:"write",handler:(_request,ctx)=>ctx.mutate({body:reserve=>Effect.gen(function*(){
 const range=yield* reserve(2);
 return {outcome:range.to,events:["example.warning","http.request"].map((type,index)=>({seq:range.from+index,at:1,type,level:"warn",actor:ctx.agent,instance:ctx.instance,generation:ctx.generation,request_id:ctx.request,topic:null,message_id:null,payload:{secret:"never mirror this payload"}}))};
})}).pipe(Effect.map(seq=>Response.json({seq})))});`,
	);
	let app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const mirrored = async () =>
		Schema.decodeUnknownSync(rows)(
			await fixture.sql("SELECT body,meta FROM messages WHERE topic='system' ORDER BY seq"),
		);
	await expect
		.poll(mirrored)
		.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ body: expect.stringContaining("generation.live") }),
				expect.objectContaining({ body: expect.stringContaining("ext.failed") }),
			]),
		);
	const diagnostics = await app.post("/api/test-events", {}, cookie);
	expect(diagnostics.status).toBe(200);
	const diagnosticsSeq = Schema.decodeUnknownSync(Schema.Struct({ seq: Schema.Int }))(await diagnostics.json()).seq;
	await expect
		.poll(
			async () =>
				Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ seq: Schema.Int })))(
					await fixture.sql("SELECT seq FROM system_cursor WHERE id=1"),
				)[0]?.seq ?? 0,
		)
		.toBeGreaterThanOrEqual(diagnosticsSeq);
	await expect
		.poll(mirrored)
		.toEqual(
			expect.arrayContaining([expect.objectContaining({ body: expect.stringContaining("warn: example.warning") })]),
		);
	const initial = await mirrored();
	const rootView = await (await fetch(`${app.url}/api/topics?mark=0`, { headers: { cookie } })).json();
	expect(rootView.messages).toEqual(
		expect.arrayContaining([expect.objectContaining({ topic: "system", instance: "extension:system.ts" })]),
	);
	expect(
		initial.every(
			(row) =>
				!row.body.includes("private diagnostic payload") &&
				!row.body.includes("never mirror this payload") &&
				!row.body.includes("http.request") &&
				!row.meta.includes("never mirror this payload"),
		),
	).toBe(true);
	await fixture.sql(
		"CREATE TRIGGER hold_system_checkpoint BEFORE UPDATE ON system_cursor BEGIN SELECT RAISE(ABORT,'checkpoint unavailable'); END",
	);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	await expect
		.poll(mirrored)
		.toEqual(expect.arrayContaining([expect.objectContaining({ body: expect.stringContaining("lock.acquired") })]));
	const beforeRestart = await mirrored();
	await app.stop("SIGKILL");
	await fixture.sql("DROP TRIGGER hold_system_checkpoint");
	app = await fixture.launch(join(seed, "server.ts"));
	await app.ready(cookie);
	await expect.poll(async () => (await mirrored()).filter((row) => row.body.includes("lock.acquired")).length).toBe(1);
	await expect.poll(async () => (await mirrored()).length).toBeGreaterThan(beforeRestart.length);
	const afterRestart = await mirrored();
	const sources = afterRestart.map(
		(row) => Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ event_seq: Schema.Int })))(row.meta).event_seq,
	);
	expect(new Set(sources).size).toBe(sources.length);
	// Ordinary messages are ignored, but their scanned sequence still advances the durable cursor.
	const posted = await (
		await app.post("/api/messages", { topic: "ordinary", body: "not a system event" }, cookie)
	).json();
	await expect
		.poll(
			async () =>
				Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ seq: Schema.Int })))(
					await fixture.sql("SELECT seq FROM system_cursor WHERE id=1"),
				)[0]?.seq ?? 0,
		)
		.toBeGreaterThanOrEqual(posted.seq);
	expect((await mirrored()).some((row) => row.body.includes("message.created"))).toBe(false);
}, 30000);
