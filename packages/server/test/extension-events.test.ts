import { sourcePut } from "./fixtures/source-put.ts";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("delivers only published message payloads through live hooks and disables a failing subscriber independently", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "event-seed"),
		record = join(fixture.root, "events.jsonl");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/observer.ts"),
		`import {Effect,FileSystem} from "effect";
 export default api=>Effect.gen(function*(){
  const fs=yield* FileSystem.FileSystem;
  api.on("message.created",(payload,ctx)=>payload.topic==="system"?Effect.void:fs.writeFileString(${JSON.stringify(record)},JSON.stringify({payload,seq:ctx.event.seq,instance:ctx.event.instance})+"\\n",{flag:"a"}));
 });`,
	);
	await writeFile(
		join(seed, "ext/bad-observer.ts"),
		'export default api=>api.on("message.created",async(payload)=>{if(payload.topic!=="system")throw Error("subscriber failed")});',
	);
	await writeFile(
		join(seed, "ext/oversized.ts"),
		'export default api=>{for(let i=0;i<5;i++)api.on("topic."+"x".repeat(100)+i,async()=>{});};',
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string) => fetch(app.url + path, { headers: { cookie } });
	const first = await (await app.post("/api/messages", { topic: "hooks", body: "first" }, cookie)).json();
	const rows = async () => {
		try {
			return (await readFile(record, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	};
	await expect.poll(rows).toEqual([
		expect.objectContaining({
			payload: expect.objectContaining({ id: first.id, body: "first" }),
			seq: first.seq,
			instance: first.instance,
		}),
	]);
	await expect
		.poll(async () => await (await get("/api/ext")).json())
		.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "bad-observer.ts",
					status: "disabled",
					error: expect.stringContaining("subscriber failed"),
				}),
				expect.objectContaining({ name: "observer.ts", status: "loaded", events: ["message.created"] }),
				expect.objectContaining({
					name: "oversized.ts",
					status: "disabled",
					error: expect.stringContaining("512 combined"),
				}),
			]),
		);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const put = await sourcePut(app.url + "/api/fs/app/ext/unused.ts", {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: "export default api=>{};",
	});
	expect(await put.json()).toMatchObject({ status: "live" });
	const second = await (await app.post("/api/messages", { topic: "hooks", body: "second" }, cookie)).json();
	await expect
		.poll(rows)
		.toEqual([
			expect.objectContaining({ seq: first.seq, payload: expect.objectContaining({ body: "first" }) }),
			expect.objectContaining({ seq: second.seq, payload: expect.objectContaining({ body: "second" }) }),
		]);
	// Real candidate health writes private probe messages; none reaches any callback.
	expect((await rows()).length).toBe(2);
}, 25000);
