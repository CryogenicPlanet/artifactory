import { sourcePut } from "./fixtures/source-put.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, type TestContext } from "vitest";
import { resetFixture } from "./fixtures/source-reset.ts";

async function failingRestart(test: TestContext, boundary: "backup" | "accepted" | "accepted-lookup" | "history") {
	const fixture = await resetFixture(test);
	const generations = join(fixture.boot, "src/generations.ts");
	const source = await readFile(generations, "utf8");
	const needle = "healthy: (n: number) =>\n\t\t\tEffect.gen(function* () {";
	expect(source.split(needle)).toHaveLength(2);
	await writeFile(
		generations,
		source
			.replace("Context, DateTime, Effect, Layer, Schema", "Context, DateTime, Effect, FileSystem, Layer, Schema")
			.replace(
				needle,
				`${needle}
				const fs = yield* FileSystem.FileSystem;
				const marker = ${JSON.stringify(join(fixture.root, "fail-healthy"))};
				if (${JSON.stringify(boundary !== "history")} && (yield* fs.exists(marker))) {
					yield* fs.remove(marker);
					yield* sql\`SELECT * FROM injected_missing_health_table\`;
				}`,
			),
	);
	const transport = join(fixture.boot, "src/child-process.ts");
	const child = await readFile(transport, "utf8");
	const control =
		'const control = (action: Parameters<typeof transition>[0]) => transition(action).pipe(Effect.timeout("5 seconds"));';
	expect(child.split(control)).toHaveLength(2);
	await writeFile(
		transport,
		child.replace(
			control,
			`const control = (action: Parameters<typeof transition>[0]) => Effect.gen(function* () {
		const marker = ${JSON.stringify(join(fixture.root, "fail-control"))};
		if (action === ${JSON.stringify(boundary === "backup" || boundary === "history" ? "frozen" : "accepted")} && (yield* fs.exists(marker))) {
			yield* fs.remove(marker);
			yield* fs.writeFileString(${JSON.stringify(join(fixture.root, "fail-healthy"))}, "fail next health catalog update");
			return yield* new ChildError({ code: "child_control_failed" });
		}
		return yield* transition(action).pipe(Effect.timeout("5 seconds"));
	});`,
		),
	);
	if (boundary === "accepted-lookup") {
		const filename = join(fixture.boot, "src/cutover.ts");
		const source = await readFile(filename, "utf8");
		const needle = "const selected = (yield* generations.list).find((item) => item.n === acceptedGeneration);";
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			filename,
			source.replace(
				needle,
				`
			if (yield* fs.exists(${JSON.stringify(join(fixture.root, "fail-healthy"))})) {
				yield* fs.remove(${JSON.stringify(join(fixture.root, "fail-healthy"))});
				yield* sql\`SELECT * FROM injected_missing_generation_lookup\`;
			}
			${needle}`,
			),
		);
	}
	if (boundary === "history") {
		const filename = join(fixture.boot, "src/supervisor.ts");
		const source = await readFile(filename, "utf8");
		const needle = "yield* (yield* Generations).list.pipe(Effect.flatMap((rows) => Ref.set(history, rows)));";
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			filename,
			source.replace(
				needle,
				`
			if (yield* fs.exists(${JSON.stringify(join(fixture.root, "fail-healthy"))})) {
				const sql = yield* SqlClient.SqlClient;
				yield* sql\`SELECT * FROM injected_missing_activation_history\`;
			}
			${needle}`,
			),
		);
	}
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(
		(await app.post("/api/messages", { topic: "retained", body: "acknowledged before recovery" }, cookie)).status,
	).toBe(200);
	await writeFile(join(fixture.root, "fail-control"), "trigger one targeted restart");
	return { fixture, app, cookie };
}

it("retries a backup's failed health catalog write after positive retirement", async (test) => {
	const { fixture, app, cookie } = await failingRestart(test, "backup");
	const response = await app.post("/_boot/db/backup", {}, cookie);
	expect(response.status).toBe(500);
	await app.ready(cookie);
	const status = await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
	expect(status.traffic.frozen).toBe(false);
	expect(await fixture.sql("SELECT closed FROM child_attempts ORDER BY rowid", "boot.db")).toEqual([
		{ closed: 1 },
		{ closed: 1 },
		{ closed: 0 },
	]);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='retained' ORDER BY seq")).toEqual([
		{ body: "acknowledged before recovery" },
	]);
	expect((await app.post("/api/messages", { topic: "retained", body: "recovered writer" }, cookie)).status).toBe(200);
}, 30000);

for (const boundary of ["accepted", "accepted-lookup"] as const) {
	it(`resolves accepted cutover evidence after ${boundary} failure`, async (test) => {
		const { fixture, app, cookie } = await failingRestart(test, boundary);
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		const response = await sourcePut(`${app.url}/api/fs/app/accepted.txt`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test" },
			body: "accepted source must survive",
		});
		expect(response.status).toBe(500);
		await app.ready(cookie);
		expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
		expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 0 }]);
		expect(await readFile(join(fixture.root, "app/accepted.txt"), "utf8")).toBe("accepted source must survive");
		expect(await fixture.sql("SELECT body FROM messages WHERE topic='retained' ORDER BY seq")).toEqual([
			{ body: "acknowledged before recovery" },
		]);
		expect(
			(await app.post("/api/messages", { topic: "retained", body: "accepted generation resumed" }, cookie)).status,
		).toBe(200);
	}, 30000);
}

it("stops at the existing retry cap when activation history consistently fails", async (test) => {
	const { fixture, app, cookie } = await failingRestart(test, "history");
	expect((await app.post("/_boot/db/backup", {}, cookie)).status).toBe(500);
	const attempts = () => fixture.sql("SELECT closed FROM child_attempts ORDER BY rowid", "boot.db");
	const closed = [{ closed: 1 }, { closed: 1 }, { closed: 1 }, { closed: 1 }, { closed: 1 }];
	await expect.poll(attempts, { timeout: 10000 }).toEqual(closed);
	// Longer than both existing recovery backoffs: no new batch starts after cap exhaustion.
	await delay(750);
	expect(await attempts()).toEqual(closed);
	const status = await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
	expect(status).toMatchObject({ child: { state: "failed", attempt: 3 }, traffic: { frozen: false } });
	expect((await app.post("/api/messages", { topic: "retained", body: "must remain unavailable" }, cookie)).status).toBe(
		503,
	);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='retained' ORDER BY seq")).toEqual([
		{ body: "acknowledged before recovery" },
	]);
}, 30000);

it("releases unavailable queues after closure even when accepted authority recovery fails", async (test) => {
	const { fixture, app, cookie } = await failingRestart(test, "accepted-lookup");
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	await fixture.sql(
		"CREATE TRIGGER refuse_recovery_finish BEFORE UPDATE OF cutover_in_flight ON edit_lock WHEN NEW.cutover_in_flight=0 BEGIN SELECT RAISE(ABORT,'recovery finish unavailable'); END",
		"boot.db",
	);
	const response = await sourcePut(`${app.url}/api/fs/app/accepted.txt`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: "accepted source must survive",
	});
	expect(response.status).toBe(500);
	await expect
		.poll(async () => (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json())
		.toMatchObject({
			child: { state: "failed" },
			source_recovery_error: expect.stringContaining("recovery finish unavailable"),
			traffic: { frozen: false },
		});
	expect(await fixture.sql("SELECT phase FROM cutover", "boot.db")).toEqual([{ phase: "accepted" }]);
	expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 1 }]);
	expect(await fixture.sql("SELECT COUNT(*) AS n FROM child_attempts WHERE closed=0", "boot.db")).toEqual([{ n: 0 }]);
	expect((await app.post("/api/messages", { topic: "retained", body: "must not publish" }, cookie)).status).toBe(503);
	expect(await readFile(join(fixture.root, "app/accepted.txt"), "utf8")).toBe("accepted source must survive");
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='retained' ORDER BY seq")).toEqual([
		{ body: "acknowledged before recovery" },
	]);
}, 30000);

it("keeps queued admission frozen while all-owner closure proof is missing", async (test) => {
	const fixture = await resetFixture(test);
	const filename = join(fixture.boot, "src/index.ts");
	const source = await readFile(filename, "utf8");
	const needle = "yield* supervisor.recoverClosure;";
	expect(source.split(needle)).toHaveLength(2);
	// Hold admission before the real root closure check; the negative proof must not release it.
	await writeFile(filename, source.replace(needle, `yield* supervisor.freeze; ${needle}`));
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(
		(await app.post("/api/messages", { topic: "retained", body: "acknowledged before missing proof" }, cookie)).status,
	).toBe(200);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	await fixture.sql("UPDATE edit_lock SET cutover_in_flight=1,reset_pin=1", "boot.db");
	await app.stop();
	const receipt = join(fixture.root, "attempts/missing-owner.closed");
	await fixture.sql(
		`INSERT INTO child_attempts(id,generation,receipt,opened,closed) VALUES('missing-owner',1,'${receipt}',1,0)`,
		"boot.db",
	);
	const lock = await fixture.sql("SELECT * FROM edit_lock", "boot.db");
	const resumed = await fixture.launch();
	await expect
		.poll(async () => (await fetch(`${resumed.url}/_boot/status`, { headers: { cookie } })).json(), { timeout: 10000 })
		.toMatchObject({
			child: { state: "failed" },
			source_recovery_error: expect.stringContaining("child_closure_unproven"),
			traffic: { frozen: true },
		});
	expect(await fixture.sql("SELECT * FROM edit_lock", "boot.db")).toEqual(lock);
	expect(await fixture.sql("SELECT closed FROM child_attempts WHERE id='missing-owner'", "boot.db")).toEqual([
		{ closed: 0 },
	]);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='retained' ORDER BY seq")).toEqual([
		{ body: "acknowledged before missing proof" },
	]);
	expect((await fetch(`${resumed.url}/api/fs/app/server.ts`, { headers: { cookie } })).status).toBe(200);
}, 30000);
