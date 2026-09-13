import { healthReadyHeader } from "@comms/protocol/headers";
import { Effect, Redacted } from "effect";
import { sourcePut } from "./fixtures/source-put.ts";
import { render } from "@comms/storage/store";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, symlink, writeFile } from "node:fs/promises";
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
			sourcePut(`${app.url}/api/fs/app/migrations/002_custom.ts`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: migration(body),
			});
		const failedAt = performance.now();
		const failed = await put(
			`yield* sql\`CREATE TABLE custom_data(value TEXT)\`; if (process.env.STATE === "${stage}") { yield* sql\`DELETE FROM messages\`; return yield* Effect.die("migration deliberately failed"); }`,
		);
		expect(await failed.json()).toMatchObject({ status: "failed" });
		// Terminal migration failures must not consume the 30-second rehearsal readiness budget.
		expect(performance.now() - failedAt).toBeLessThan(10000);
		await app.ready(cookie);
		expect(await fixture.sql("SELECT body FROM messages WHERE topic!='system'")).toEqual([{ body: "acknowledged" }]);
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

for (const fails of [false, true]) {
	it(`waits for guarded go before migrating, then reports ${fails ? "terminal initialization failure" : "successful migration"}`, async (test) => {
		const fixture = await conversation(test),
			app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		await app.stop();
		await fixture.sql("DROP TABLE migrations");
		await fixture.sql("DROP TABLE webhook_subscriptions");
		await fixture.sql(
			"DELETE FROM extension_migrations WHERE extension='subscriptions' AND name='webhook_subscriptions'",
		);
		await fixture.sql("UPDATE kernel_writer SET epoch='candidate-test'");
		let entry = join(import.meta.dirname, "../src/server.ts");
		if (fails) {
			const seed = join(fixture.root, "failed-seed");
			await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
			await symlink(join(import.meta.dirname, "../node_modules"), join(seed, "node_modules"));
			await writeFile(
				join(seed, "migrations/002_failure.ts"),
				migration('return yield* Effect.die("private migration failure sentinel");'),
			);
			entry = join(seed, "server.ts");
		}
		const child = spawn("bun", [entry], {
			env: {
				...process.env,
				PORT: "0",
				BOOT_SECRET: "candidate-test-secret",
				BOOT_URL: "http://127.0.0.1:1",
				WRITER_EPOCH: "candidate-test",
				APP_STORE: Redacted.value(
					await Effect.runPromise(render({ _tag: "file", filename: join(fixture.root, "comms.db") })),
				),
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
		const healthUrl = `http://127.0.0.1:${port}/health`;
		const headers = { "x-boot-secret": "candidate-test-secret" };
		const starting = await fetch(healthUrl, { headers });
		expect(starting.status).toBe(503);
		expect(starting.headers.get(healthReadyHeader)).toBeNull();
		expect(await starting.text()).toBe("");
		await delay(100);
		expect(await fixture.sql("SELECT name FROM sqlite_master WHERE name='migrations'")).toEqual([]);
		const response = await fetch(`http://127.0.0.1:${port}/_kernel/control`, {
			method: "POST",
			headers: { "x-boot-secret": "candidate-test-secret", "content-type": "application/json" },
			body: JSON.stringify({ action: "go" }),
		});
		expect(response.status).toBe(200);
		if (fails) {
			await expect
				.poll(async () => (await fetch(healthUrl, { headers })).headers.get(healthReadyHeader), { timeout: 5000 })
				.toBe("1");
			const failed = await fetch(healthUrl, { headers });
			expect(failed.status).toBe(503);
			expect(await failed.json()).toEqual({ status: "failed" });
			for (const rejectedHeaders of [{}, { ...headers, "x-forwarded-host": "comms.test" }]) {
				const rejected = await fetch(healthUrl, { headers: rejectedHeaders });
				expect(rejected.status, Object.keys(rejectedHeaders).join(",")).toBe(403);
				expect(rejected.headers.get(healthReadyHeader)).toBeNull();
				expect(await rejected.text()).toBe("");
			}
			const unavailable = await fetch(`http://127.0.0.1:${port}/api/messages`, { headers });
			expect(unavailable.status).toBe(503);
			expect(unavailable.headers.get(healthReadyHeader)).toBeNull();
			expect(await unavailable.text()).toBe("");
			expect(await fixture.sql("SELECT name FROM sqlite_master WHERE name='migrations'")).toEqual([]);
		} else {
			await expect
				.poll(() => fixture.sql("SELECT name FROM sqlite_master WHERE name='migrations'"))
				.toEqual([{ name: "migrations" }]);
		}
	}, 20000);
}

it("lets the extension own fresh webhook storage and preserves retired migration receipts and rows", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(await fixture.sql("SELECT * FROM migrations")).toEqual([]);
	expect(await fixture.sql("SELECT name FROM extension_migrations WHERE extension='subscriptions'")).toEqual([
		{ name: "webhook_subscriptions" },
	]);
	await app.stop();
	// Reconstruct a previously applied app migration without changing its ID, name or timestamp.
	await fixture.sql(
		"INSERT INTO migrations(migration_id,name,created_at) VALUES(1,'webhook_subscriptions','2026-01-01 00:00:00')",
	);
	await fixture.sql(
		`INSERT INTO webhook_subscriptions(id,instance,agent,human,input,idempotency_key,created_at,start_seq,created_seq,deleted_seq,cursor,attempts,next_attempt,last_error) VALUES('legacy','legacy','legacy',0,'{"filter":{},"deliver":{"kind":"webhook","url":"https://example.test/hook"}}','kept',1,1,1,2,1,3,4,'retained failure')`,
	);
	const ledger = await fixture.sql("SELECT * FROM migrations");
	const receipts = await fixture.sql("SELECT * FROM extension_migrations WHERE extension='subscriptions'");
	const subscriptions = await fixture.sql("SELECT * FROM webhook_subscriptions");
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(await fixture.sql("SELECT * FROM migrations")).toEqual(ledger);
	expect(await fixture.sql("SELECT * FROM extension_migrations WHERE extension='subscriptions'")).toEqual(receipts);
	expect(await fixture.sql("SELECT * FROM webhook_subscriptions")).toEqual(subscriptions);
}, 20000);
