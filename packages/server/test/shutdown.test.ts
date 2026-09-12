import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

const ownerSchema = Schema.Array(Schema.Struct({ id: Schema.String, receipt: Schema.String }));
const statusSchema = Schema.Struct({ child: Schema.Struct({ pid: Schema.Number }) });

it("drains an idle app event long-poll on SIGTERM within ten seconds with positive child closure evidence", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	// Prime the shared publication wait, which must be released before the public listener closes.
	const messages = await fetch(`${app.url}/api/messages?mark=0`, { headers: { cookie } });
	expect(messages.status).toBe(200);
	await messages.arrayBuffer();
	const waiting = await fetch(`${app.url}/api/events?since=0&types=shutdown.never&wait=60`, {
		headers: { cookie },
	});
	expect(waiting.status).toBe(200);
	const status = Schema.decodeUnknownSync(statusSchema)(
		await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json(),
	);
	const owners = Schema.decodeUnknownSync(ownerSchema)(
		await fixture.sql("SELECT id,receipt FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
	);
	expect(owners).toHaveLength(1);
	const started = performance.now();
	expect(app.processHandle.kill("SIGTERM")).toBe(true);
	// The fixture's stop() forcibly kills after four seconds; await the real process directly instead.
	await expect.poll(() => app.processHandle.exitCode, { timeout: 10000 }).not.toBeNull();
	expect(app.processHandle.exitCode).toBe(130);
	expect(performance.now() - started).toBeLessThan(10000);
	expect(app.processHandle.signalCode).toBeNull();
	expect(await waiting.json()).toMatchObject({ items: [], drained: true, timed_out: false });
	expect(() => process.kill(status.child.pid, 0)).toThrow();
	for (const owner of owners) expect(await readFile(owner.receipt, "utf8")).toBe(owner.id);
	expect(
		await fixture.sql("SELECT COUNT(*) AS count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
	).toEqual([{ count: 0 }]);
}, 30000);

it("lets an admitted extension publish during SIGTERM, rejects new public work, and retains the write after restart", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	const admitted = join(fixture.root, "admitted");
	const release = join(fixture.root, "release");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/held-write.ts"),
		`import {Effect,FileSystem} from "effect";
export default api => api.route("POST", "/api/held-write", {
 description: "Hold admitted work until the test permits its durable write", scope: "write",
 handler: (_request,ctx) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(${JSON.stringify(admitted)}, "admitted");
  while (!(yield* fs.exists(${JSON.stringify(release)}))) yield* Effect.sleep("10 millis");
  return Response.json(yield* ctx.messages.create({topic:"shutdown",body:"admitted before SIGTERM"}, "shutdown-write"));
 })
});`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const pending = app.post("/api/held-write", {}, cookie).then(async (response) => ({
		status: response.status,
		body: await response.json(),
	}));
	// Attach a rejection observer immediately so a broken shutdown cannot cause an unhandled rejection.
	void pending.catch(() => undefined);
	await expect.poll(() => readFile(admitted, "utf8").catch(() => ""), { timeout: 5000 }).toBe("admitted");
	expect(app.processHandle.kill("SIGTERM")).toBe(true);
	await expect
		.poll(
			async () => {
				const response = await fetch(`${app.url}/api/messages?mark=0`, {
					headers: { cookie },
					signal: AbortSignal.timeout(1000),
				});
				await response.arrayBuffer();
				return response.status;
			},
			{ timeout: 3000 },
		)
		.toBe(503);
	expect(app.processHandle.exitCode).toBeNull();
	await writeFile(release, "release");
	const response = await pending;
	expect(response.status).toBe(200);
	expect(response.body).toMatchObject({ topic: "shutdown", body: "admitted before SIGTERM" });
	await expect.poll(() => app.processHandle.exitCode, { timeout: 10000 }).not.toBeNull();
	expect(app.processHandle.exitCode).toBe(130);
	expect(app.processHandle.signalCode).toBeNull();
	const rows = [{ body: "admitted before SIGTERM" }];
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='shutdown'")).toEqual(rows);
	const eventQuery =
		"SELECT json_extract(event,'$.payload.body') AS body FROM events WHERE json_extract(event,'$.type')='message.created' AND json_extract(event,'$.topic')='shutdown'";
	expect(await fixture.sql(eventQuery, "boot.db")).toEqual(rows);
	const restarted = await fixture.launch(join(seed, "server.ts"));
	const renewedCookie = await restarted.login();
	await restarted.ready(renewedCookie);
	const query = await fetch(`${restarted.url}/api/messages?topic=shutdown&since=0&mark=0`, {
		headers: { cookie: renewedCookie },
	});
	expect(query.status).toBe(200);
	expect(await query.json()).toMatchObject({ items: [response.body] });
	expect(await fixture.sql(eventQuery, "boot.db")).toEqual(rows);
}, 40000);
