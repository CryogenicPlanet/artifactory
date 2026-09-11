import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

const statusSchema = Schema.Struct({
	child: Schema.Struct({
		state: Schema.String,
		pid: Schema.NullOr(Schema.Finite),
		error: Schema.NullOr(Schema.String),
	}),
});
const ownersSchema = Schema.Array(Schema.Struct({ id: Schema.String, receipt: Schema.String }));

it("retires a SQLite aggregate that blocks the app while preserving boot access, keeper proof and acknowledged writes", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string) => fetch(`${app.url}${path}`, { headers: { cookie }, signal: AbortSignal.timeout(3000) });
	const status = async () => Schema.decodeUnknownSync(statusSchema)(await (await get("/_boot/status")).json());
	const initial = (await status()).child;
	if (initial.pid === null) throw Error("Live child has no PID");
	const oldPid = initial.pid;
	const owners = Schema.decodeUnknownSync(ownersSchema)(
		await fixture.sql("SELECT id,receipt FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
	);
	expect(owners).toHaveLength(1);
	const owner = owners[0];
	if (!owner) throw Error("Live child has no durable owner");
	const input = { topic: "watchdog", body: "Acknowledged before SQLite hung" };
	const posted = await app.post("/api/messages", input, cookie, "before-sql-hang");
	expect(posted.status).toBe(200);
	const message: unknown = await posted.json();
	let settled = false;
	// The aggregate consumes the recursive input before emitting its sole row, bypassing the output row cap.
	const pending = fetch(`${app.url}/api/sql`, {
		method: "POST",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
		body: JSON.stringify({ sql: "WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n) SELECT sum(v) FROM n" }),
		signal: AbortSignal.timeout(30000),
	}).then(
		async (response) => {
			await response.arrayBuffer();
			settled = true;
			return response.status;
		},
		() => {
			settled = true;
			return null;
		},
	);
	await delay(500);
	expect(settled).toBe(false);
	expect((await status()).child).toEqual(initial);
	expect((await fetch(`${app.url}/_boot/status`, { signal: AbortSignal.timeout(3000) })).status).toBe(401);
	expect((await get("/api/fs/app/server.ts")).status).toBe(200);
	const secondCookie = await app.login();
	expect((await fetch(`${app.url}/_boot`, { headers: { cookie: secondCookie } })).status).toBe(200);
	await expect
		.poll(
			async () => {
				const current = (await status()).child;
				return { replaced: current.state === "live" && current.pid !== null && current.pid !== oldPid, child: current };
			},
			{ timeout: 20000, interval: 200 },
		)
		.toMatchObject({ replaced: true });
	expect(() => process.kill(oldPid, 0)).toThrow();
	expect(await readFile(owner.receipt, "utf8")).toBe(owner.id);
	expect(await fixture.sql(`SELECT closed FROM child_attempts WHERE id='${owner.id}'`, "boot.db")).toEqual([
		{ closed: 1 },
	]);
	const failedStatus = await pending;
	expect(failedStatus === null || failedStatus >= 500).toBe(true);
	expect(await (await app.post("/api/messages", input, cookie, "before-sql-hang")).json()).toEqual(message);
	expect(await (await get("/api/messages?since=0&topic=watchdog")).json()).toMatchObject({ items: [message] });
	expect((await app.post("/api/messages", { ...input, body: "Writes work after recovery" }, cookie)).status).toBe(200);
}, 45000);

it("keeps the same child alive while an asynchronous extension request exceeds the watchdog response budget", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "watchdog-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/watchdog-wait.ts"),
		`export default api => api.route("GET", "/api/watchdog-wait", {
 description: "Wait asynchronously without blocking the app event loop", scope: "read",
 handler: async () => {
  await new Promise(resolve => setTimeout(resolve, 8000));
  return Response.json({completed: true});
 }
});`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string) => fetch(`${app.url}${path}`, { headers: { cookie } });
	const initial = Schema.decodeUnknownSync(statusSchema)(await (await get("/_boot/status")).json());
	const response = await get("/api/watchdog-wait");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ completed: true });
	const final = Schema.decodeUnknownSync(statusSchema)(await (await get("/_boot/status")).json());
	expect(final.child).toEqual(initial.child);
	expect(final.child.state).toBe("live");
}, 30000);
