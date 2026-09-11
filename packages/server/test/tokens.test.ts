import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

const Pair = Schema.Struct({ access: Schema.String, refresh: Schema.String, family: Schema.String });
const Enrollment = Schema.Struct({ id: Schema.String, device_secret: Schema.String });
const enroll = async (app: Awaited<ReturnType<Awaited<ReturnType<typeof conversation>>["launch"]>>) => {
	const e = Schema.decodeUnknownSync(Enrollment)(
		await (await app.post("/auth/enroll", { name: "codex", kind: "codex", host: "laptop" })).json(),
	);
	const params = { id: e.id, decision: "approve" as const, scopes: ["read"], long_lived: false };
	const proof = await app.assertion(params);
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${e.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", "x-comms-assertion": proof },
				body: JSON.stringify({ decision: "approve", scopes: ["read"], long_lived: false }),
			})
		).status,
	).toBe(200);
	return Schema.decodeUnknownSync(Pair)(
		await (await app.post(`/auth/enroll/${e.id}`, { device_secret: e.device_secret })).json(),
	);
};
it("refreshes across restart, treats denied-scope access as use, and commits reuse revocation despite an app publication gap", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const original = await enroll(app);
	const responses = await Promise.all([
		app.post("/auth/refresh", { refresh: original.refresh }, undefined, "retry"),
		app.post("/_boot/refresh", { refresh: original.refresh }, undefined, "other"),
	]);
	expect(responses.map((r) => r.status)).toEqual([200, 200]);
	const first = await responses[0]?.json(),
		second = await responses[1]?.json();
	expect(first).toEqual(second);
	const pair = Schema.decodeUnknownSync(Pair)(first);
	for (const input of [{ refresh: original.access }, { refresh: "invalid" }])
		expect((await app.post("/auth/refresh", input)).status).toBe(401);
	expect((await app.post("/auth/refresh", { refresh: pair.refresh }, undefined, "retry")).status).toBe(409);
	expect((await app.post("/auth/refresh", { refresh: pair.refresh, extra: true })).status).toBe(400);
	expect((await app.post("/auth/refresh?extra=1", { refresh: pair.refresh })).status).toBe(400);
	expect((await app.post("/auth/refresh", { refresh: pair.refresh }, undefined, "x".repeat(129))).status).toBe(400);
	await app.stop();
	const again = await fixture.launch();
	await again.ready(cookie);
	expect(await (await again.post("/auth/refresh", { refresh: original.refresh }, undefined, "retry")).json()).toEqual(
		first,
	);
	const denied = await fetch(`${again.url}/api/messages`, {
		method: "POST",
		headers: { authorization: `Bearer ${pair.access}`, "content-type": "application/json" },
		body: JSON.stringify({ topic: "test", body: "forbidden" }),
	});
	expect(denied.status).toBe(403);
	await fixture.sql("UPDATE tokens SET rotated_at=rotated_at-60000 WHERE rotated_to IS NOT NULL", "boot.db");
	await fixture.sql(
		"UPDATE seq SET next=next+1,pending_id='blocked',pending_attempt='blocked',pending_from=next,pending_to=next WHERE singleton=1",
		"boot.db",
	);
	const reused = await again.post("/auth/refresh", { refresh: original.refresh });
	expect(reused.status).toBe(401);
	expect(await reused.json()).toMatchObject({ error: { code: "family_revoked" } });
	expect(await fixture.sql("SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL", "boot.db")).toEqual([{ n: 0 }]);
	expect(
		await fixture.sql(
			"SELECT COUNT(*) AS n FROM events WHERE json_extract(event,'$.type')='token.family_revoked'",
			"boot.db",
		),
	).toEqual([{ n: 1 }]);
	for (const access of [original.access, pair.access])
		expect((await fetch(`${again.url}/api/messages`, { headers: { authorization: `Bearer ${access}` } })).status).toBe(
			401,
		);
}, 25000);
it("requires a live human session at revocation commit, binds its signed family, and survives logout during a held body", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	let cookie = await app.login();
	await app.ready(cookie);
	const pair = await enroll(app);
	const action = { action: "token.revoke", params: { family: pair.family } };
	expect((await app.post("/_boot/auth/challenge", action)).status).toBe(401);
	expect(
		(
			await fetch(`${app.url}/_boot/auth/challenge`, {
				method: "POST",
				headers: {
					origin: "https://comms.test",
					authorization: `Bearer ${pair.access}`,
					cookie,
					"content-type": "application/json",
				},
				body: JSON.stringify(action),
			})
		).status,
	).toBe(401);
	for (const expire of [false, true]) {
		const proof = await app.revocationAssertion(pair.family, cookie);
		const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
			const held = request(
				`${app.url}/api/tokens/${pair.family}/revoke`,
				{
					method: "POST",
					headers: {
						cookie,
						origin: "https://comms.test",
						"content-type": "application/json",
						"content-length": "2",
						"x-comms-assertion": proof,
					},
				},
				(res) => {
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						body += chunk;
					});
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
				},
			);
			held.on("error", reject);
			test.onTestFinished(() => {
				held.destroy();
			});
			held.write("{");
			void (async () => {
				try {
					await delay(100);
					if (expire) await fixture.sql("UPDATE sessions SET expires_at=0", "boot.db");
					else expect((await app.post("/_boot/auth/logout", {}, cookie)).status).toBe(204);
					held.end("}");
				} catch (error) {
					held.destroy();
					reject(error);
				}
			})();
		});
		expect((await response).status).toBe(401);
		const proofId = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ id: Schema.String })))(
			Buffer.from(proof, "base64url").toString("utf8"),
		).id;
		// A consumed proof proves the request passed initial session admission and reached the post-body transaction.
		expect(await fixture.sql(`SELECT id FROM auth_challenges WHERE id='${proofId}'`, "boot.db")).toEqual([]);
		expect(await fixture.sql("SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NOT NULL", "boot.db")).toEqual([
			{ n: 0 },
		]);
		cookie = await app.login();
	}
	const proof = await app.revocationAssertion(pair.family, cookie);
	const call = (family = pair.family, origin = "https://comms.test") =>
		fetch(`${app.url}/_boot/tokens/${family}/revoke`, {
			method: "POST",
			headers: { cookie, origin, "content-type": "application/json", "x-comms-assertion": proof },
			body: "{}",
		});
	expect((await call(undefined, "https://evil.test")).status).toBe(403);
	expect((await call(`f_${"z".repeat(43)}`)).status).toBe(401);
	expect((await call()).status).toBe(200);
	expect((await call()).status).toBe(401);
	expect((await app.post("/auth/refresh", { refresh: pair.refresh })).status).toBe(401);
}, 20000);
