import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";
import evlogSink from "../pages/tooling/evlog-sink.ts";

it("offers an opt-in authenticated NDJSON drain with a resumable cursor", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	expect(typeof evlogSink).toBe("function");
	const example = await readFile(join(import.meta.dirname, "../pages/tooling/evlog-sink.ts"), "utf8");
	await writeFile(join(seed, "ext/evlog.ts"), example.replaceAll("../../src/", "../"));
	await writeFile(
		join(seed, "ext/trace.ts"),
		`import { Effect } from "effect";
export default api => api.route("GET", "/api/trace", { description: "Trace verification", scope: "read", handler: (_, ctx) => Effect.gen(function* () {
 yield* ctx.log.set({ topic: "work/trace" });
 yield* ctx.log.set({ message_id: "m_trace" }).pipe(Effect.withSpan("nested"));
 yield* Effect.logWarning("trace-test authorization=private");
 return new Response("ok");
}) });`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await fetch(`${app.url}/api/evlog`)).status).toBe(401);
	expect((await fetch(`${app.url}/api/trace`, { headers: { cookie } })).status).toBe(200);
	await expect
		.poll(async () => await (await fetch(`${app.url}/api/evlog?since=0`, { headers: { cookie } })).text())
		.toContain("trace-test [redacted]");
	const response = await fetch(`${app.url}/api/evlog?since=0`, { headers: { cookie } });
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("application/x-ndjson");
	const cursor = response.headers.get("x-evlog-cursor");
	expect(Number.isSafeInteger(Number(cursor))).toBe(true);
	const through = response.headers.get("x-evlog-through");
	expect(through).toBe(cursor);
	const done = await fetch(`${app.url}/api/evlog?since=${cursor}&until=${through}`, { headers: { cookie } });
	expect(await done.text()).toBe("");
	expect(done.headers.get("x-evlog-cursor")).toBe(through);
	const rows = (await response.text())
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	expect(rows.length).toBeGreaterThan(0);
	expect(rows).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				message: "log",
				level: "warn",
				data: { message: "trace-test [redacted]", failure: false },
			}),
			expect.objectContaining({
				message: "http.request",
				topic: "work/trace",
				data: expect.objectContaining({
					annotations: { topic: "work/trace", message_id: "m_trace", extension: "trace.ts" },
				}),
			}),
		]),
	);
	for (const row of rows)
		expect(row).toMatchObject({ timestamp: expect.any(String), level: expect.any(String), seq: expect.any(Number) });
	expect((await fetch(`${app.url}/api/evlog?since=-1`, { headers: { cookie } })).status).toBe(400);
});
