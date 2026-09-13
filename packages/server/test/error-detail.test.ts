import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("names the offending field and the rule it broke without adding an error code", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "project", body: "seed" }, cookie)).status).toBe(200);
	const refusal = async (response: Response) => {
		expect(response.status, await response.clone().text()).toBe(400);
		const body = (await response.json()) as {
			readonly error: { readonly code: string; readonly hint: string; readonly field?: string };
		};
		// One code covers all of these; the field and hint are what makes each one actionable.
		expect(body.error.code).toBe("input_invalid");
		return body.error;
	};
	const uppercase = await refusal(await app.post("/api/messages", { topic: "Project/Bad", body: "x" }, cookie));
	expect(uppercase.field).toBe("topic");
	expect(uppercase.hint).toContain("lowercase");
	const empty = await refusal(await app.post("/api/messages", { topic: "project", body: "" }, cookie));
	expect(empty.field).toBe("body");
	expect(empty.hint).toContain("Body cannot be empty.");
	const unknown = await refusal(
		await app.post("/api/messages", { topic: "project", body: "x", priority: "high" }, cookie),
	);
	expect(unknown.field).toBe("priority");
	expect(unknown.hint).toContain("no field named priority");
	const both = await refusal(
		await fetch(`${app.url}/api/topics/project`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
			body: JSON.stringify({ meta: {}, archived: true }),
		}),
	);
	expect(["archived", "meta"]).toContain(both.field);
	expect(both.hint).toContain("different request shapes");
	expect(both.hint).toContain("archived, meta");
	// Four unrelated mistakes previously shared one hint word for word.
	expect(new Set([uppercase.hint, empty.hint, unknown.hint, both.hint]).size).toBe(4);
	const valid = await app.post("/api/messages", { topic: "project", body: "still fine" }, cookie);
	expect(valid.status).toBe(200);
	expect((await valid.json()).topic).toBe("project");
}, 30000);
