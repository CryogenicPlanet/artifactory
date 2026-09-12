import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Api } from "@comms/protocol";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("executes the shared generated client against authenticated nested topic and mutation routes", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await Effect.runPromise(
		Effect.gen(function* () {
			const client = yield* HttpApiClient.make(Api, {
				baseUrl: app.url,
				transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders({ cookie, origin: "https://comms.test" })),
			});
			const input = { topic: "generated/nested", body: "one durable message" };
			const headers = { "idempotency-key": "generated-message" };
			const message = yield* client.conversation.create({ payload: input, headers });
			expect(yield* client.conversation.create({ payload: input, headers })).toEqual(message);
			const topic = yield* client.topics.detail({ params: { path: input.topic }, query: { mark: "0", depth: 2 } });
			expect(topic.messages).toEqual([message]);
			const root = yield* client.topics.root({ query: { mark: "0" } });
			expect(root.subtopics.some((topic) => topic.path === "generated")).toBe(true);
			const metaRequest = {
				params: { path: input.topic },
				query: {},
				payload: { meta: { owner: "reader" } },
				headers: { "idempotency-key": "generated-meta" },
			};
			const meta = yield* client.topicManagement.meta(metaRequest);
			expect(yield* client.topicManagement.meta(metaRequest)).toEqual(meta);
			const moved = yield* client.topicManagement.move({
				params: { path: input.topic },
				query: {},
				payload: { to: "generated/moved" },
				headers: { "idempotency-key": "generated-move" },
			});
			expect(moved).toMatchObject({ from: input.topic, to: "generated/moved" });
			const raw = yield* Effect.promise(() =>
				fetch(`${app.url}/api/topics/generated/moved?mark=0`, { headers: { cookie } }).then((response) =>
					response.json(),
				),
			);
			expect(raw).toMatchObject({ path: "generated/moved", meta: { owner: "reader" } });
			const me = yield* client.profiles.me({ query: {} });
			expect(me.body.kind).toBe("human");
			expect(me.headers["cache-control"]).toBe("no-store");
			const extensions = yield* client.ext.list({});
			expect(extensions.some((extension) => extension.name === "core.ts")).toBe(true);
		}).pipe(Effect.provide(FetchHttpClient.layer)),
	);
});

it("keeps later wildcard extension ownership for generated and raw topic URLs", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/zz-topic-override.ts"),
		`
import { Effect } from "effect";
export default api => {
 api.route("GET", "/api/topics/*", { description: "Override topic reads", scope: "read", handler: (request,ctx) => Effect.gen(function* () {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const path = pathname === "/api/topics" ? "" : decodeURIComponent(pathname.slice("/api/topics/".length));
  return Response.json(yield* ctx.topics.read(path), { headers: { "x-topic-owner": "override" } });
 }) });
 for (const method of ["PUT", "POST"]) api.route(method, "/api/topics/*", { description: "Override topic writes", scope: "write", handler: () => Response.json({ owner: "override" }) });
};`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await app.post("/api/messages", { topic: "parent/nested", body: "preserved" }, cookie);
	for (const path of ["/parent", "/parent/nested", "/parent%2Fnested"]) {
		const response = await fetch(`${app.url}/api/topics${path}`, { headers: { cookie } });
		expect(response.status, path).toBe(200);
		expect(response.headers.get("x-topic-owner"), path).toBe("override");
	}
	for (const method of ["PUT", "POST"]) {
		for (const path of ["parent", "parent/nested", "parent%2Fnested"]) {
			const response = await fetch(`${app.url}/api/topics/${path}${method === "POST" ? "/move" : ""}`, {
				method,
				headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
				body: "{}",
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ owner: "override" });
		}
	}
});
