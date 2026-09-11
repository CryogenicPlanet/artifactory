import { Clock, Effect } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("returns verified caller identity while removed product routes stay absent from HTTP and OpenAPI", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string) => fetch(app.url + path, { headers: { cookie } });
	expect((await fetch(app.url + "/api/me")).status).toBe(401);
	const human = await (await get("/api/me")).json();
	expect(human).toMatchObject({ agent: "rahul", kind: "human", label: "human", scopes: ["read", "write", "fs"] });
	expect(human.expires_at).toBeGreaterThan(await Effect.runPromise(Clock.currentTimeMillis));
	const message = await (await app.post("/api/messages", { topic: "kept", body: "retained" }, cookie)).json();
	for (const [method, path, body] of [
		["GET", "/api/inbox", undefined],
		["GET", "/api/ctx", undefined],
		["GET", "/api/search?q=retained", undefined],
		["GET", "/api/agents", undefined],
		["GET", `/api/messages/${message.id}`, undefined],
		["POST", "/api/read", { topic: "kept", seq: message.seq }],
		["PATCH", "/api/me", { status: "removed" }],
		["PATCH", "/api/topics/kept", { archived: true }],
		["DELETE", "/api/topics/kept", undefined],
	] satisfies Array<[string, string, unknown]>) {
		const response = await fetch(app.url + path, {
			method,
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		expect([404, 405], `${method} ${path}`).toContain(response.status);
	}
	const docs = await (await get("/api")).json();
	for (const path of ["/api/inbox", "/api/ctx", "/api/search", "/api/read", "/api/agents"])
		expect(docs.paths).not.toHaveProperty(path);
	expect(docs.paths["/api/me"].get).toBeDefined();
	expect(docs.paths["/api/me"]).not.toHaveProperty("patch");
	expect(docs.paths["/api/messages/{ref}"]).not.toHaveProperty("get");
	expect((await (await get("/api/messages?since=0&mark=0")).json()).items).toEqual([message]);
}, 30000);
