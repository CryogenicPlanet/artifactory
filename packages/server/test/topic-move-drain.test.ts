import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { Schema } from "effect";
import { conversation } from "./fixtures/conversation.ts";

it("drains an aborted extension GET only after its returned Promise completes its late SQL write", async (test) => {
	const fixture = await conversation(test);
	const source = join(fixture.root, "request-app");
	await cp(join(import.meta.dirname, "../src"), source, { recursive: true });
	const original = await readFile(join(source, "server.ts"), "utf8");
	const marker = "yield* Console.log(`COMMS_CHILD_PORT=${http.address.port}`);";
	const instrumented = original.replace(
		marker,
		`yield* Effect.promise(() => Bun.write(${JSON.stringify(join(fixture.root, "child.json"))}, JSON.stringify({ port: http.address.port, secret: Redacted.value(secret) })));
${marker}`,
	);
	expect(instrumented).not.toBe(original);
	await writeFile(join(source, "server.ts"), instrumented);
	await writeFile(
		join(source, "ext/request-drain.ts"),
		`
import { Effect } from "effect";
export default function(api) {
 api.route("GET", "/api/late-write", { description: "Held request", scope: "read", handler: async (_request, ctx) => {
  const root = ${JSON.stringify(fixture.root)};
  await Bun.write(root + "/started", "started");
  while (!(await Bun.file(root + "/release").exists())) await Bun.sleep(10);
  await Effect.runPromise(ctx.db\`INSERT INTO late_request VALUES('finished')\`);
  await Bun.write(root + "/finished", "finished");
  return new Response("finished");
 }});
}
`,
	);
	const boot = await fixture.launch(join(source, "server.ts"));
	await boot.setup();
	const cookie = await boot.login();
	await boot.ready(cookie);
	await fixture.sql("CREATE TABLE late_request(value TEXT)");
	const child = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ port: Schema.Int, secret: Schema.String })))(
		await readFile(join(fixture.root, "child.json"), "utf8"),
	);
	const url = `http://127.0.0.1:${child.port}`;
	const secret = { "x-boot-secret": child.secret };
	const control = (action: string) =>
		fetch(`${url}/_kernel/control`, {
			method: "POST",
			headers: { ...secret, "content-type": "application/json" },
			body: JSON.stringify({ action }),
		});
	const identity = {
		...secret,
		"x-comms-agent": "codex",
		"x-comms-instance": "family",
		"x-comms-auth-kind": "agent",
		"x-comms-scopes": "read",
		"x-comms-request-id": "held",
	};
	const aborted = new AbortController();
	const pending = fetch(`${url}/api/late-write`, { headers: identity, signal: aborted.signal }).catch(() => null);
	await expect.poll(() => readFile(join(fixture.root, "started"), "utf8").catch(() => "")).toBe("started");
	aborted.abort();
	await pending;
	let drained = false;
	const drain = control("draining").then(async (response) => {
		expect(response.status).toBe(200);
		const body: unknown = await response.json();
		drained = true;
		return body;
	});
	await expect.poll(async () => (await fetch(`${url}/api/topics`, { headers: identity })).status).toBe(503);
	await delay(150);
	expect(drained).toBe(false);
	expect(await fixture.sql("SELECT value FROM late_request")).toEqual([]);
	await writeFile(join(fixture.root, "release"), "release");
	expect(await drain).toMatchObject({ state: "draining", mutations: 0, requests: 0 });
	expect(await readFile(join(fixture.root, "finished"), "utf8")).toBe("finished");
	expect(await fixture.sql("SELECT value FROM late_request")).toEqual([{ value: "finished" }]);
}, 20000);
