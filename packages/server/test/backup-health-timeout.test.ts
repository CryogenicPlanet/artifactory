import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resetFixture } from "./fixtures/source-reset.ts";

it("releases unavailable admission after a backup restart misses health and proves closure", async (test) => {
	const fixture = await resetFixture(test);
	const filename = join(fixture.boot, "src/child-process.ts");
	const source = await readFile(filename, "utf8");
	const control =
		'const control = (action: Parameters<typeof transition>[0]) => transition(action).pipe(Effect.timeout("5 seconds"));';
	const health = "const health = Effect.gen(function* () {";
	expect(source.split(control)).toHaveLength(2);
	expect(source.split(health)).toHaveLength(2);
	// Fault only the disposable child transport: supervisor, timeout, retirement and keeper remain real.
	await writeFile(
		filename,
		source
			.replace(
				control,
				`const control = (action: Parameters<typeof transition>[0]) => Effect.gen(function* () {
		if (action === "frozen" && (yield* fs.exists(options.env.APP_DATABASE + ".stall-health")))
			return yield* new ChildError({ code: "child_control_failed" });
		return yield* transition(action).pipe(Effect.timeout("5 seconds"));
	});`,
			)
			.replace(
				health,
				`${health}
		if (yield* fs.exists(options.env.APP_DATABASE + ".stall-health")) {
			yield* fs.writeFileString(options.env.APP_DATABASE + ".health-waiting", "waiting");
			return yield* Effect.never;
		}`,
			),
	);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(
		(await app.post("/api/messages", { topic: "retained", body: "acknowledged before backup" }, cookie)).status,
	).toBe(200);
	await writeFile(join(fixture.root, "comms.db.stall-health"), "stall replacement only");
	const backup = app.post("/_boot/db/backup", {}, cookie);
	await expect
		.poll(async () => readFile(join(fixture.root, "comms.db.health-waiting"), "utf8").catch(() => ""), {
			timeout: 10000,
		})
		.toBe("waiting");
	const queued = app.post("/api/messages", { topic: "retained", body: "must not enter failed child" }, cookie);
	// Cleanup may close this socket if an earlier assertion fails; retain the rejection for the awaited branch.
	void queued.catch(() => undefined);
	const result = await backup;
	const status = await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
	expect(status.traffic).toMatchObject({ frozen: false });
	expect(result.status).toBe(409);
	expect(await result.json()).toMatchObject({ error: { code: "health_failed" } });
	// The existing 60-second queue deadline must not be what completes this request.
	expect(
		(
			await Promise.race([
				queued,
				new Promise<never>((_, reject) => {
					const timeout = setTimeout(() => reject(new Error("admission stayed frozen")), 2000);
					queued.finally(() => clearTimeout(timeout)).catch(() => {});
				}),
			])
		).status,
	).toBe(503);
	expect(await fixture.sql("SELECT closed FROM child_attempts ORDER BY rowid", "boot.db")).toEqual([
		{ closed: 1 },
		{ closed: 1 },
	]);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='retained' ORDER BY seq")).toEqual([
		{ body: "acknowledged before backup" },
	]);
}, 30000);
