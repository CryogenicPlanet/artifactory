import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, type TestContext } from "vitest";
import { resetFixture } from "./fixtures/source-reset.ts";

async function checkRecovery(test: TestContext, realTimeouts: 1 | 2) {
	const fixture = await resetFixture(test);
	const filename = join(fixture.boot, "src/child-process.ts");
	const source = 'import { FileSystem as FaultFileSystem } from "effect";\n' + (await readFile(filename, "utf8"));
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
		const fs = yield* FaultFileSystem.FileSystem;
		if (action === "frozen" && (yield* fs.exists(options.env.APP_DATABASE + ".stall-health")))
			return yield* new ChildError({ code: "child_control_failed" });
		return yield* transition(action).pipe(Effect.timeout("5 seconds"));
	});`,
			)
			.replace(
				health,
				`${health}
		const fs = yield* FaultFileSystem.FileSystem;
		if (yield* fs.exists(options.env.APP_DATABASE + ".stall-health")) {
			const marker = options.env.APP_DATABASE + ".health-waiting";
			const attempt = (yield* fs.exists(marker)) ? 2 : 1;
			if (attempt > ${realTimeouts} || (yield* fs.exists(marker + ".second")))
				return yield* new ChildError({ code: "health_failed" });
			yield* fs.writeFileString(marker, "waiting");
			if (attempt === 2) yield* fs.writeFileString(marker + ".second", "waiting");
			const started = performance.now();
			return yield* Effect.never.pipe(Effect.ensuring(
				Effect.suspend(() => fs.writeFileString(marker + ".elapsed-" + attempt, String(performance.now() - started)))
			));
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
	const recoveryStarted = performance.now();
	const backup = app.post("/_boot/db/backup", {}, cookie);
	await expect
		.poll(async () => readFile(join(fixture.root, "comms.db.health-waiting"), "utf8").catch(() => ""), {
			timeout: 10000,
		})
		.toBe("waiting");
	expect(await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()).toMatchObject({
		child: { state: "starting", error: "route_withdrawn" },
	});
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
	expect(await fixture.sql("SELECT closed FROM child_attempts WHERE rowid<=2 ORDER BY rowid", "boot.db")).toEqual([
		{ closed: 1 },
		{ closed: 1 },
	]);
	// The targeted failure gets one bounded ordinary recovery pass, not an idle retry loop.
	await expect
		.poll(() => fixture.sql("SELECT closed FROM child_attempts ORDER BY rowid", "boot.db"), { timeout: 20000 })
		.toEqual([{ closed: 1 }, { closed: 1 }, { closed: 1 }, { closed: 1 }, { closed: 1 }]);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='retained' ORDER BY seq")).toEqual([
		{ body: "acknowledged before backup" },
	]);
	if (realTimeouts === 2) {
		const elapsed = await Promise.all(
			[1, 2].map(async (attempt) =>
				Number(await readFile(join(fixture.root, `comms.db.health-waiting.elapsed-${attempt}`), "utf8")),
			),
		);
		for (const duration of elapsed) expect(duration).toBeGreaterThanOrEqual(4900);
		const recoveryMs = performance.now() - recoveryStarted;
		expect(recoveryMs).toBeGreaterThanOrEqual(9800);
		console.info(
			JSON.stringify({ real_health_timeouts: realTimeouts, health_wait_ms: elapsed, recovery_ms: recoveryMs }),
		);
	}
}

it(
	"releases unavailable admission after a backup restart misses health and proves closure",
	(test) => checkRecovery(test, 1),
	30000,
);

it(
	"measures two consecutive real health deadlines before bounded recovery exhaustion",
	(test) => checkRecovery(test, 2),
	45000,
);
