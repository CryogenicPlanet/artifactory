import { cp, readFile, writeFile } from "node:fs/promises";
import { conversation } from "../fixtures/conversation.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each([
	"clean",
	"nested",
	"queued",
	"rollback-defect",
	"cleanup-wait",
	"cleanup-overrun",
	"cancel-overrun",
	"queued-outer-mask",
])(
	"preserves read deadline cleanup: %s",
	async (mode) => {
		const { stdout } = await promisify(execFile)("bun", [
			join(import.meta.dirname, "../fixtures/read-deadline.ts"),
			mode,
		]);
		expect(stdout).toContain("READ_DEADLINE_VERIFIED");
	},
	15000,
);

it("returns the cooperative timeout after cleanup and lets a queued write finish on the same child", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../../src"), seed, { recursive: true });
	const entered = join(fixture.root, "read-entered");
	const cleaned = join(fixture.root, "read-cleaned");
	await writeFile(
		join(seed, "ext/read-budget.ts"),
		`import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
export default api => api.route("GET", "/api/read-budget", {
 description: "Exercise cooperative read cleanup", scope: "read",
 handler: (_request, ctx) => ctx.read(() => Effect.gen(function* () {
  yield* Effect.promise(() => writeFile(${JSON.stringify(entered)}, "entered"));
  return yield* Effect.never;
 }).pipe(Effect.ensuring(Effect.promise(() => writeFile(${JSON.stringify(cleaned)}, "cleaned")))))
});`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const state = () => fetch(`${app.url}/_boot/status`, { headers: { cookie } }).then((response) => response.json());
	const before = await state();
	const pending = fetch(`${app.url}/api/read-budget`, { headers: { cookie } });
	void pending.catch(() => undefined);
	await expect.poll(() => readFile(entered, "utf8").catch(() => "")).toBe("entered");
	const write = app.post("/api/messages", { topic: "deadline", body: "queued durable write" }, cookie);
	void write.catch(() => undefined);
	const response = await pending;
	expect(response.status).toBe(408);
	expect(await response.json()).toMatchObject({ error: { code: "read_snapshot_timeout", retriable: false } });
	expect(await readFile(cleaned, "utf8")).toBe("cleaned");
	expect((await write).status).toBe(200);
	expect((await state()).child).toEqual(before.child);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='deadline'")).toEqual([
		{ body: "queued durable write" },
	]);
}, 15000);

it("retires an uninterruptible async reader through boot's unhealthy-ping keeper boundary", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../../src"), seed, { recursive: true });
	const entered = join(fixture.root, "uninterruptible-entered");
	await writeFile(
		join(seed, "ext/read-overrun.ts"),
		`import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
export default api => api.route("GET", "/api/read-overrun", {
 description: "Exercise reader retirement", scope: "read",
 handler: (_request, ctx) => ctx.read(() => Effect.gen(function* () {
  yield* Effect.promise(() => writeFile(${JSON.stringify(entered)}, "entered"));
  return yield* Effect.never;
 }).pipe(Effect.uninterruptible))
});`,
	);
	// Observe the real private ping without routing another request through the occupied admission gate.
	const entry = join(seed, "server.ts");
	const source = await readFile(entry, "utf8");
	const pingStatus = "status: (yield* Ref.get(lifecycle.healthy)) ? 200 : 503,";
	expect(source.split(pingStatus)).toHaveLength(2);
	await writeFile(
		entry,
		'import { writeFile as recordPing, access as hasReadMarker } from "node:fs/promises";\n' +
			source.replace(
				pingStatus,
				`status: yield* Ref.get(lifecycle.healthy).pipe(
 Effect.tap((healthy) => Effect.promise(async () => {
  try { await hasReadMarker(${JSON.stringify(entered)}); } catch { return; }
  await recordPing(${JSON.stringify(entered)} + "." + process.pid + (healthy ? ".200" : ".503"), "seen");
 })), Effect.map((healthy) => healthy ? 200 : 503)),`,
			),
	);
	const app = await fixture.launch(entry);
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const status = () => fetch(`${app.url}/_boot/status`, { headers: { cookie } }).then((response) => response.json());
	const before = await status();
	const originalAttempt = await fixture.sql("SELECT id FROM child_attempts", "boot.db");
	const pending = fetch(`${app.url}/api/read-overrun`, { headers: { cookie } }).catch(() => null);
	await expect.poll(() => readFile(entered, "utf8").catch(() => "")).toBe("entered");
	// Positive ping responses after callback entry distinguish async blocking from an event-loop stall.
	await expect
		.poll(() => readFile(`${entered}.${before.child.pid}.200`, "utf8").catch(() => ""), { timeout: 3000 })
		.toBe("seen");
	await expect
		.poll(() => readFile(`${entered}.${before.child.pid}.503`, "utf8").catch(() => ""), { timeout: 10000 })
		.toBe("seen");
	await expect
		.poll(() => fixture.sql("SELECT id FROM child_attempts WHERE closed=1", "boot.db"), { timeout: 15000 })
		.toEqual(originalAttempt);
	expect(() => process.kill(before.child.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
	await pending;
	// Boot recovers the retained generation only after positive keeper closure evidence.
	await expect
		.poll(
			async () => {
				const current = (await status()).child;
				return current.state === "live" && current.pid !== before.child.pid;
			},
			{ timeout: 15000 },
		)
		.toBe(true);
	expect((await app.post("/api/messages", { topic: "overrun", body: "recovered writer" }, cookie)).status).toBe(200);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='overrun'")).toEqual([{ body: "recovered writer" }]);
}, 30000);
