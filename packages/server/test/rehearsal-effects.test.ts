import { sourcePut } from "./fixtures/source-put.ts";
import { createServer } from "node:http";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("rehearses real hooks with no external delivery, reports suppression, and rolls back hook writes", async (test) => {
	const received: string[] = [];
	const sink = createServer((request, response) => {
		received.push(request.url ?? "");
		response.end("ok");
	});
	await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
	test.onTestFinished(
		() =>
			new Promise<void>((resolve) => {
				sink.closeAllConnections();
				sink.close(() => resolve());
			}),
	);
	const address = sink.address();
	if (!address || typeof address === "string") throw new Error("Missing sink address");
	const origin = `http://127.0.0.1:${address.port}`;
	const fixture = await conversation(test);
	const seed = join(fixture.root, "effects-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/effects.ts"),
		`import {Effect} from "effect";
import {HttpClientRequest} from "effect/unstable/http";
export default api => {
 api.cron("0 0 * * *", () => Effect.void);
 api.on("start", (event,ctx) => Effect.gen(function*(){
  if(event.reason === "rehearsal") {
   yield* ctx.messages.create({topic:"rehearsal",body:"must roll back"});
   yield* ctx.messages.create({topic:"rehearsal",body:"also rolled back"});
   yield* ctx.kv().set("rehearsal-only", "temporary");
   yield* ctx.log("rehearsal.test", {});
  }
  yield* api.effects.fetch(HttpClientRequest.get(${JSON.stringify(`${origin}/private-token?secret=query`)}), response=>response.text);
  yield* api.effects.notify(${JSON.stringify(`${origin}/notify?secret=query`)}, {secret:"body-secret"});
  yield* api.effects.timer(10, api.effects.notify(${JSON.stringify(`${origin}/timer`)}, {}).pipe(Effect.asVoid));
 }));
};`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await expect.poll(() => received.length).toBe(3);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const result = await sourcePut(`${app.url}/api/fs/app/migrations/002_advisory.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: `import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
export default Effect.gen(function* () {
 const sql = yield* SqlClient.SqlClient;
 yield* sql\`CREATE TABLE rehearsal_advisory(value TEXT)\`;
});`,
	});
	const outcome = await result.json();
	expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "live" });
	await expect.poll(() => received.length).toBe(6);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='rehearsal'")).toEqual([]);
	expect(await fixture.sql("SELECT key FROM kv WHERE key='rehearsal-only'")).toEqual([]);
	const events = await (
		await fetch(`${app.url}/api/events?since=0&types=generation.rehearsed`, { headers: { cookie } })
	).json();
	expect(events.items).toHaveLength(1);
	expect(events.items[0].payload).toEqual({
		suppressed: [
			{ extension: "effects.ts", kind: "cron", reason: "rehearsal", expression: "0 0 * * *" },
			{ extension: "effects.ts", kind: "fetch", reason: "rehearsal", method: "GET", destination: origin },
			{ extension: "effects.ts", kind: "notify", reason: "rehearsal", method: "POST", destination: origin },
			{ extension: "effects.ts", kind: "timer", reason: "rehearsal", delay_ms: 10 },
		],
		suppressed_overflow: 0,
		warnings: { items: [{ code: "migration.non_portable", migration: "2_advisory" }], overflow: 0 },
	});
	expect(JSON.stringify(events.items[0].payload)).not.toMatch(/private-token|secret|body-secret/);
}, 45000);
