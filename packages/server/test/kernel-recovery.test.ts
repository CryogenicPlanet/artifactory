import { spawn, execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";
const execute = promisify(execFile);
async function setup(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-kernel-recovery-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const script = join(import.meta.dirname, "fixtures/kernel-faults.ts");
	const run = async (mode: string) => (await execute("bun", [script, root, mode])).stdout;
	const sql = async (statement: string, name = "comms.db") =>
		Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
			(
				await execute("bun", [
					join(import.meta.dirname, "../../boot/test/fixtures/store.ts"),
					join(root, name),
					statement,
				])
			).stdout,
		);
	return { root, script, run, sql };
}
it("rolls back after a lost reserve response, resolves its reservation and allows an unchanged retry", async (test) => {
	const app = await setup(test);
	expect(await app.run("reserve-lost")).toContain("ROLLBACK_CONFIRMED");
	expect(await app.sql("SELECT count(*) AS count FROM messages")).toEqual([{ count: 1 }]);
	expect(await app.sql("SELECT state FROM event_batches ORDER BY from_seq", "boot.db")).toEqual([
		{ state: "aborted" },
		{ state: "published" },
	]);
}, 10000);
it.for(["beforecommit", "aftercommit", "afterappend"])(
	"recovers kernel crash at %s without losing or duplicating acknowledged data",
	{ timeout: 12000 },
	async (mode, test) => {
		const app = await setup(test);
		const child = spawn("bun", [app.script, app.root, mode], { stdio: ["ignore", "pipe", "pipe"] });
		test.onTestFinished(() => {
			child.kill("SIGKILL");
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += String(chunk);
		});
		await expect.poll(() => output, { timeout: 5000 }).toContain("PAUSED");
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		expect(await app.sql("SELECT count(*) AS count FROM messages")).toEqual([
			{ count: mode === "beforecommit" ? 0 : 1 },
		]);
		const result = await app.run("normal");
		expect(result).toContain("durable");
		expect(await app.sql("SELECT count(*) AS count FROM messages")).toEqual([{ count: 1 }]);
		expect(await app.sql("SELECT count(*) AS count FROM outbox WHERE shipped_at IS NULL")).toEqual([{ count: 0 }]);
		expect(
			await app.sql(
				"SELECT count(*) AS count FROM events WHERE json_extract(event,'$.type')='message.created'",
				"boot.db",
			),
		).toEqual([{ count: 1 }]);
	},
);

it("closes the old child after boot SIGKILL and publishes its previously committed evidence", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "test-seed");
	await mkdir(seed);
	const entry = join(seed, "child.ts");
	await writeFile(
		entry,
		`import {run} from ${JSON.stringify(join(import.meta.dirname, "fixtures/orphan-child.ts"))}; run();`,
	);
	const first = await fixture.launch(entry);
	await first.setup();
	const cookie = await first.login();
	await first.ready(cookie);
	const status = Schema.decodeUnknownSync(
		Schema.Struct({ child: Schema.Struct({ pid: Schema.Int, port: Schema.Int }) }),
	)(await (await fetch(`${first.url}/_boot/status`, { headers: { cookie } })).json());
	test.onTestFinished(() => {
		try {
			process.kill(status.child.pid, "SIGKILL");
		} catch {}
	});
	const orphan = `http://127.0.0.1:${status.child.port}`;
	const admitted = fetch(`${orphan}/admit`, { method: "POST" });
	await expect.poll(async () => (await (await fetch(`${orphan}/held`)).json()).held).toBe(true);
	expect((await admitted).status).toBe(200);
	await first.stop("SIGKILL");
	const next = await fixture.launch(entry);
	await next.ready(cookie);
	await expect(fetch(`${orphan}/write`, { method: "POST" })).rejects.toThrow();
	expect(await fixture.sql("SELECT id FROM orphan_writes")).toEqual([{ id: "admitted" }]);
	expect(
		await (await fetch(`${next.url}/api/events?since=0&types=message.created`, { headers: { cookie } })).json(),
	).toMatchObject({
		items: [{ payload: { body: "committed by admitted orphan" } }],
	});
}, 20000);

it("rejects wrong and stale channel credentials, including a request body held across attempt rotation", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "test-seed");
	await mkdir(seed);
	const entry = join(seed, "child.ts");
	await writeFile(
		entry,
		`import {run} from ${JSON.stringify(join(import.meta.dirname, "fixtures/orphan-child.ts"))}; run();`,
	);
	const app = await fixture.launch(entry);
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const state = async () =>
		Schema.decodeUnknownSync(
			Schema.Struct({
				child: Schema.Struct({ pid: Schema.NullOr(Schema.Int), port: Schema.NullOr(Schema.Int), state: Schema.String }),
			}),
		)(await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json());
	const first = await state();
	if (first.child.pid === null) throw Error("Missing child");
	const channel = Schema.decodeUnknownSync(Schema.Struct({ secret: Schema.String }))(
		await (await fetch(`http://127.0.0.1:${first.child.port}/channel`)).json(),
	);
	for (const headers of [
		{ "x-boot-secret": "wrong" },
		{ "x-boot-secret": channel.secret, "x-forwarded-for": "127.0.0.1" },
	])
		expect((await fetch(`${app.url}/_boot/seq`, { headers })).status).toBe(403);
	const wrongHost = await new Promise<number>((resolve, reject) => {
		const request = httpRequest(
			`${app.url}/_boot/seq`,
			{ headers: { "x-boot-secret": channel.secret, host: "localhost" } },
			(response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			},
		);
		request.on("error", reject);
		request.end();
	});
	expect(wrongHost).toBe(403);
	let completed: (status: number) => void = () => {};
	const result = new Promise<number>((resolve) => {
		completed = resolve;
	});
	const request = httpRequest(
		`${app.url}/_boot/seq/reserve`,
		{ method: "POST", headers: { "x-boot-secret": channel.secret, "content-type": "application/json" } },
		(response) => {
			response.resume();
			completed(response.statusCode ?? 0);
		},
	);
	test.onTestFinished(() => {
		request.destroy();
	});
	request.on("error", () => completed(0));
	await new Promise<void>((resolve, reject) =>
		request.write('{"transaction":"late-body",', (error) => (error ? reject(error) : resolve())),
	);
	await delay(50);
	process.kill(first.child.pid, "SIGKILL");
	await expect
		.poll(
			async () => {
				const next = await state();
				return next.child.state === "live" && next.child.pid !== first.child.pid;
			},
			{ timeout: 1800, interval: 20 },
		)
		.toBe(true);
	request.end('"count":1}');
	expect(await result).toBe(403);
	expect((await fetch(`${app.url}/_boot/seq`, { headers: { "x-boot-secret": channel.secret } })).status).toBe(403);
	expect(await fixture.sql("SELECT id FROM event_batches WHERE id='late-body'", "boot.db")).toEqual([]);
}, 10000);
