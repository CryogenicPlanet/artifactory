import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

const inventory = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			reason: Schema.String,
			bytes: Schema.Int,
			taken_at: Schema.Int,
			published_through: Schema.NullOr(Schema.Int),
			generation: Schema.NullOr(Schema.Int),
		}),
	),
	next: Schema.NullOr(Schema.String),
});

it("lists backup metadata with a human session and rejects every Authorization header", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const enrollment = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, device_secret: Schema.String }))(
		await (await app.post("/auth/enroll", { name: "backup-agent", kind: "codex", host: "test" })).json(),
	);
	const params = {
		id: enrollment.id,
		decision: "approve" as const,
		scopes: ["read", "write", "fs"],
		long_lived: false,
	};
	const proof = await app.assertion(params);
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", "x-comms-assertion": proof },
				body: JSON.stringify({ decision: params.decision, scopes: params.scopes, long_lived: false }),
			})
		).status,
	).toBe(200);
	const pair = Schema.decodeUnknownSync(Schema.Struct({ access: Schema.String }))(
		await (await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })).json(),
	);
	const url = `${app.url}/_boot/db/backups`;
	expect((await fetch(url)).status).toBe(401);
	for (const authorization of [`Bearer ${pair.access}`, "Bearer invalid", "Basic invalid", ""]) {
		for (const headers of [{ authorization }, { authorization, cookie }])
			expect((await fetch(url, { headers })).status).toBe(401);
	}
	await fixture.sql(
		"INSERT INTO backups(id,path,reason,bytes,taken_at,published_through,generation) VALUES ('legacy','/private/backup-never-created.db','pre-flip',2048,10,NULL,NULL),('new','/private/current.db','hourly',4096,20,123,7)",
		"boot.db",
	);
	const response = await fetch(url, { headers: { cookie } });
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	expect(response.headers.get("x-comms-token-expires")).toMatch(/^\d+$/);
	expect(await response.json()).toEqual({
		items: [
			{ id: "new", reason: "hourly", bytes: 4096, taken_at: 20, published_through: 123, generation: 7 },
			{ id: "legacy", reason: "pre-flip", bytes: 2048, taken_at: 10, published_through: null, generation: null },
		],
		next: null,
	});
	for (const method of ["POST", "PUT", "PATCH", "DELETE"])
		expect((await fetch(url, { method, headers: { cookie, origin: "https://comms.test" } })).status).toBe(501);
}, 20000);

it("paginates timestamp ties by stable keysets and strictly validates bounded query parameters", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const rows = Array.from(
		{ length: 205 },
		(_, index) => `('b${String(index).padStart(3, "0")}','/unused','hourly',1,1000,NULL,NULL)`,
	);
	await fixture.sql(
		`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through,generation) VALUES ${rows.join(",")},('z-oldest','/unused','hourly',1,999,NULL,NULL)`,
		"boot.db",
	);
	const get = async (query = "") => {
		const response = await fetch(`${app.url}/_boot/db/backups${query}`, { headers: { cookie } });
		expect(response.status).toBe(200);
		return Schema.decodeUnknownSync(inventory)(await response.json());
	};
	const first = await get();
	expect(first.items).toHaveLength(100);
	expect(first.items[0]?.id).toBe("b204");
	expect(first.items.at(-1)?.id).toBe("b105");
	expect(first.next).toEqual(expect.any(String));
	if (first.next === null) throw new Error("Missing continuation cursor");
	await fixture.sql("DELETE FROM backups WHERE id='b105'", "boot.db");
	await fixture.sql(
		"INSERT INTO backups(id,path,reason,bytes,taken_at) VALUES ('newer','/unused','hourly',1,2000)",
		"boot.db",
	);
	const second = await get(`?before=${encodeURIComponent(first.next)}`);
	expect(second.items.map((row) => row.id)).toEqual(
		Array.from({ length: 100 }, (_, index) => `b${String(104 - index).padStart(3, "0")}`),
	);
	if (second.next === null) throw new Error("Missing final-page cursor");
	const last = await get(`?before=${encodeURIComponent(second.next)}`);
	expect(last.items.map((row) => row.id)).toEqual(["b004", "b003", "b002", "b001", "b000", "z-oldest"]);
	expect(last.next).toBeNull();
	expect((await get("?limit=200")).items).toHaveLength(200);
	expect((await get("?limit=1")).items[0]?.id).toBe("newer");
	for (const query of [
		"?limit=0",
		"?limit=201",
		"?limit=-1",
		"?limit=1.5",
		"?limit=1e2",
		"?limit=",
		"?limit=nope",
		"?limit=1&limit=2",
		"?unknown=1",
		"?next=abc",
		"?before=abc",
		"?before=",
		"?before=%25",
		"?before=not-a-cursor",
		`?before=${"a".repeat(2049)}`,
		`?before=${encodeURIComponent(first.next)}&before=${encodeURIComponent(first.next)}`,
		...[
			[],
			{ taken_at: 1 },
			{ taken_at: 1, id: "b001", extra: true },
			{ taken_at: -1, id: "b001" },
			{ taken_at: Number.MAX_SAFE_INTEGER + 1, id: "b001" },
			{ taken_at: 1, id: "x".repeat(129) },
		].map((cursor) => `?before=${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`),
	])
		expect((await fetch(`${app.url}/_boot/db/backups${query}`, { headers: { cookie } })).status, query).toBe(400);
}, 20000);

it("keeps inventory available while the app is down without creating files or changing backup and non-request event state", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await app.stop();
	await rm(join(fixture.root, "comms.db"));
	const down = await fixture.launch();
	await expect
		.poll(
			async () => {
				const response = await fetch(`${down.url}/_boot/status`, { headers: { cookie } });
				return Schema.decodeUnknownSync(
					Schema.Struct({ child: Schema.Struct({ state: Schema.String, attempt: Schema.Int }) }),
				)(await response.json()).child;
			},
			{ timeout: 5000 },
		)
		.toMatchObject({ state: "failed", attempt: 3 });
	await fixture.sql(
		"INSERT INTO backups(id,path,reason,bytes,taken_at) VALUES ('missing','/private/unavailable.db','pre-flip',999,1)",
		"boot.db",
	);
	const before = await fixture.sql("SELECT * FROM backups ORDER BY id", "boot.db");
	// The listener records diagnostics for these reads; inventory must not create backup or lifecycle events.
	const events = await fixture.sql("SELECT * FROM events WHERE type != 'http.request' ORDER BY seq", "boot.db");
	const files = (await readdir(fixture.root, { recursive: true })).sort();
	for (let attempt = 0; attempt < 3; attempt++) {
		const response = await fetch(`${down.url}/_boot/db/backups`, { headers: { cookie } });
		expect(response.status).toBe(200);
		expect(Schema.decodeUnknownSync(inventory)(await response.json()).items.map((row) => row.id)).toEqual(["missing"]);
	}
	expect(await fixture.sql("SELECT * FROM backups ORDER BY id", "boot.db")).toEqual(before);
	expect(await fixture.sql("SELECT * FROM events WHERE type != 'http.request' ORDER BY seq", "boot.db")).toEqual(
		events,
	);
	expect((await readdir(fixture.root, { recursive: true })).sort()).toEqual(files);
	expect((await fetch(`${down.url}/api/messages`, { headers: { cookie } })).status).toBe(503);
}, 20000);
