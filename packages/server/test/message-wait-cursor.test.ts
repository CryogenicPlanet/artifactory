import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("a rejected first ahead-cursor wait cannot poison later message followers", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const first = await app.login(),
		second = await app.login();
	await app.ready(first);
	const rejected = await fetch(`${app.url}/api/messages?since=${Number.MAX_SAFE_INTEGER}&wait=1`, {
		headers: { cookie: first },
	});
	expect(await rejected.json()).toMatchObject({ error: { code: "cursor_ahead" } });
	// Await response headers before posting: this request has reached the empty first query.
	const waiting = await fetch(`${app.url}/api/messages?topic=follower-test&wait=20&mark=0`, {
		headers: { cookie: first },
	});
	expect(waiting.status).toBe(200);
	const posted = await app.post("/api/messages", { topic: "follower-test", body: "after rejected cursor" }, second);
	expect(posted.status).toBe(200);
	const message = await posted.json();
	expect(await waiting.json()).toMatchObject({ items: [message], timed_out: false, drained: false });
}, 35_000);
