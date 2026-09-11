import { Clock, Effect } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("keeps profiles shared by verified agent, presence per instance, and credentials private across restart", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string, authorization?: string) =>
		fetch(`${app.url}${path}`, {
			headers: authorization ? { authorization, "x-comms-agent": "rahul", "x-comms-auth-kind": "human" } : { cookie },
		});
	const patch = (value: unknown, authorization?: string) =>
		fetch(`${app.url}/api/me`, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				origin: "https://comms.test",
				...(authorization ? { authorization, "x-comms-agent": "rahul", "x-comms-scopes": "read,write" } : { cookie }),
			},
			body: JSON.stringify(value),
		});
	const enroll = async (host: string, scopes: string[]) => {
		const enrollment = await (await app.post("/auth/enroll", { name: "codex", kind: "codex-cli", host })).json();
		const proof = await app.assertion({ id: enrollment.id, decision: "approve", scopes, long_lived: false });
		expect(
			(
				await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
					method: "POST",
					headers: { origin: "https://comms.test", "content-type": "application/json", "x-comms-assertion": proof },
					body: JSON.stringify({ decision: "approve", scopes, long_lived: false }),
				})
			).status,
		).toBe(200);
		return (await (await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })).json())
			.access;
	};
	expect((await fetch(`${app.url}/api/me`)).status).toBe(401);
	const human = await (await get("/api/me")).json();
	expect(human).toMatchObject({
		agent: "rahul",
		kind: "human",
		label: "human",
		profile: { status: "", emoji: null, color: null },
	});
	expect(human.scopes).toEqual(["read", "write", "fs"]);
	expect(human.expires_at).toBeGreaterThan(await Effect.runPromise(Clock.currentTimeMillis));
	const access = await enroll("writer", ["read", "write"]);
	const siblingAccess = await enroll("reader", ["read"]);
	const bearer = `Bearer ${access}`,
		sibling = `Bearer ${siblingAccess}`;
	const writer = await (await get("/api/me", bearer)).json();
	const reader = await (await get("/api/me", sibling)).json();
	expect(writer).toMatchObject({ agent: "codex", kind: "agent", label: "writer", scopes: ["read", "write"] });
	expect(reader.instance).not.toBe(writer.instance);
	const changed = await patch({ status: "Building", emoji: "🛠️", color: "#3399AA" }, bearer);
	expect(changed.status).toBe(200);
	expect(changed.headers.get("cache-control")).toBe("no-store");
	const profile = (await changed.json()).profile;
	expect((await (await get("/api/me", sibling)).json()).profile).toEqual(profile);
	expect((await (await get("/api/me")).json()).profile.status).toBe("");
	expect((await patch({ status: "Forbidden" }, sibling)).status).toBe(403);
	for (const value of [
		{},
		{ agent: "rahul", status: "Forged" },
		{ status: null },
		{ status: "x".repeat(1025) },
		{ emoji: "bad emoji" },
		{ color: "red" },
	])
		expect((await patch(value, bearer)).status).toBe(400);
	expect((await get("/api/me?agent=rahul", bearer)).status).toBe(400);
	const roster = await (await get("/api/agents", sibling)).json();
	const codex = roster.items.find((item: { agent: string }) => item.agent === "codex");
	expect(codex).toMatchObject({ agent: "codex", kind: "codex-cli", profile });
	expect(codex.instances).toHaveLength(2);
	expect(codex.instances.map((item: { instance: string }) => item.instance)).toEqual(
		expect.arrayContaining([writer.instance, reader.instance]),
	);
	const encoded = JSON.stringify(roster);
	for (const forbidden of [access, siblingAccess, "hash", "scopes", "expires_at", "refresh"])
		expect(encoded).not.toContain(forbidden);
	const before = codex.instances.find((item: { instance: string }) => item.instance === writer.instance).last_seen_at;
	// A boot-owned request updates presence too, including scope refusal after authentication.
	expect((await get("/_boot/status", bearer)).status).toBe(403);
	const after = (await (await get("/api/agents")).json()).items.find(
		(item: { agent: string }) => item.agent === "codex",
	);
	expect(
		after.instances.find((item: { instance: string }) => item.instance === writer.instance).last_seen_at,
	).toBeGreaterThanOrEqual(before);
	expect((await patch({ emoji: null }, bearer)).status).toBe(200);
	expect((await (await get("/api/me", sibling)).json()).profile).toEqual({ ...profile, emoji: null });
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	const persisted = await (await fetch(`${resumed.url}/api/me`, { headers: { authorization: bearer } })).json();
	expect(persisted).toMatchObject({ agent: "codex", instance: writer.instance, profile: { ...profile, emoji: null } });
	const rosterAfterRestart = await (await fetch(`${resumed.url}/api/agents`, { headers: { cookie } })).json();
	expect(rosterAfterRestart.items.find((item: { agent: string }) => item.agent === "codex").instances).toHaveLength(2);
}, 30000);

it("refuses stale profile writes before changing persisted presentation", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await fixture.sql("UPDATE kernel_writer SET epoch='stale-profile-test'");
	const response = await fetch(`${app.url}/api/me`, {
		method: "PATCH",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
		body: JSON.stringify({ status: "must not write" }),
	});
	expect(response.status).toBe(503);
	expect(await fixture.sql("SELECT * FROM agents")).toEqual([]);
}, 20000);
