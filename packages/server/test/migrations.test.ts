import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";
const migration = (body: string) => `import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
export default Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; ${body} });`;
for (const stage of ["rehearsal", "candidate"]) {
	it(`rejects a ${stage} migration failure without losing acknowledged messages, then accepts a repaired migration once`, async (test) => {
		const fixture = await conversation(test),
			app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		expect((await app.post("/api/messages", { topic: "kept", body: "acknowledged" }, cookie)).status).toBe(200);
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		const put = (body: string) =>
			fetch(`${app.url}/api/fs/app/migrations/002_custom.ts`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: migration(body),
			});
		const failed = await put(
			`yield* sql\`CREATE TABLE custom_data(value TEXT)\`; if (process.env.STATE === "${stage}") { yield* sql\`DELETE FROM messages\`; return yield* Effect.die("migration deliberately failed"); }`,
		);
		expect(await failed.json()).toMatchObject({ status: "failed" });
		await app.ready(cookie);
		expect(await fixture.sql("SELECT body FROM messages")).toEqual([{ body: "acknowledged" }]);
		expect(await fixture.sql("SELECT * FROM migrations WHERE migration_id=2")).toEqual([]);
		expect(await fixture.sql("SELECT name FROM sqlite_master WHERE name='custom_data'")).toEqual([]);
		expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
		const fixed = await put(
			"yield* sql`CREATE TABLE custom_data(value TEXT)`; yield* sql`INSERT INTO custom_data VALUES('once')`;",
		);
		expect(await fixed.json()).toMatchObject({ status: "live" });
		expect(await fixture.sql("SELECT value FROM custom_data")).toEqual([{ value: "once" }]);
		expect(await fixture.sql("SELECT migration_id,name FROM migrations WHERE migration_id=2")).toEqual([
			{ migration_id: 2, name: "custom" },
		]);
		expect(await (await app.post("/api/reload", {}, cookie)).json()).toMatchObject({ status: "live" });
		expect(await fixture.sql("SELECT value FROM custom_data")).toEqual([{ value: "once" }]);
	}, 35000);
}

it("does not open or migrate the candidate database before the guarded go command", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await app.stop();
	await fixture.sql("DROP TABLE migrations");
	await fixture.sql("DROP TABLE webhook_subscriptions");
	await fixture.sql("UPDATE kernel_writer SET epoch='candidate-test'");
	const child = spawn("bun", [join(import.meta.dirname, "../src/server.ts")], {
		env: {
			...process.env,
			PORT: "0",
			BOOT_SECRET: "candidate-test-secret",
			BOOT_URL: "http://127.0.0.1:1",
			WRITER_EPOCH: "candidate-test",
			APP_DATABASE: join(fixture.root, "comms.db"),
			PAGES_DIRECTORY: join(fixture.root, "pages"),
			STATE: "candidate",
			GENERATION: "100",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	test.onTestFinished(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
	});
	let output = "";
	child.stdout.on("data", (data: Buffer) => {
		output += data.toString();
	});
	child.stderr.on("data", () => {});
	await expect.poll(() => /COMMS_CHILD_PORT=(\d+)/.exec(output)?.[1]).toBeTruthy();
	const port = /COMMS_CHILD_PORT=(\d+)/.exec(output)?.[1];
	await delay(100);
	expect(await fixture.sql("SELECT name FROM sqlite_master WHERE name='migrations'")).toEqual([]);
	const response = await fetch(`http://127.0.0.1:${port}/_kernel/control`, {
		method: "POST",
		headers: { "x-boot-secret": "candidate-test-secret", "content-type": "application/json" },
		body: JSON.stringify({ action: "go" }),
	});
	expect(response.status).toBe(200);
	await expect
		.poll(() => fixture.sql("SELECT name FROM sqlite_master WHERE name='migrations'"))
		.toEqual([{ name: "migrations" }]);
}, 20000);
