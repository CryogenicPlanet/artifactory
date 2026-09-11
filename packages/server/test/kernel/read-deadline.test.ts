import { cp, readFile, writeFile } from "node:fs/promises";
import { conversation } from "../fixtures/conversation.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each(["clean", "nested", "queued", "rollback-defect", "cleanup-wait"])(
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
