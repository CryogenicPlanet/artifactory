import { sourcePut } from "./fixtures/source-put.ts";
import { request } from "node:http";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Console, Effect } from "effect";
import { conversation } from "./fixtures/conversation.ts";

it("stages, rehearses and accepts an edit, rejects broken source, and repairs it without losing acknowledged messages", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const original = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
	const lock = await app.post("/api/lock", {}, cookie);
	expect(lock.status).toBe(200);
	const put = (source: string) =>
		sourcePut(`${app.url}/api/fs/app/server.ts?reload=0`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test" },
			body: source,
		});
	const receipts: number[] = [];
	let sending = true;
	const traffic = (async () => {
		while (sending) {
			const response = await app.post("/api/messages", { topic: "during-reload", body: "acknowledged" }, cookie);
			if (response.status === 200) receipts.push((await response.json()).seq);
			await new Promise((resolve) => setTimeout(resolve, 30));
		}
	})();
	test.onTestFinished(async () => {
		sending = false;
		await traffic;
	});
	const marker = 'if (request.url === "/health" && request.method === "GET") return yield* health;';
	const changed = original.replace(
		marker,
		`${marker}\nif (request.url === "/api/edit-marker") return HttpServerResponse.text("edited API ready");`,
	);
	expect(changed).not.toBe(original);
	expect((await put(changed)).status).toBe(200);
	const accepted = await (await app.post("/api/reload", {}, cookie)).json();
	expect(accepted).toMatchObject({ status: "live" });
	expect(await (await fetch(`${app.url}/api/edit-marker`, { headers: { cookie } })).text()).toContain(
		"edited API ready",
	);
	expect((await put("this is invalid TypeScript !")).status).toBe(200);
	expect(await (await app.post("/api/reload", {}, cookie)).json()).toMatchObject({ status: "failed" });
	expect(await (await fetch(`${app.url}/api/edit-marker`, { headers: { cookie } })).text()).toContain(
		"edited API ready",
	);
	expect((await put(original)).status).toBe(200);
	expect(await (await app.post("/api/reload?release=1", {}, cookie)).json()).toMatchObject({
		status: "live",
		lock: null,
	});
	sending = false;
	await traffic;
	expect(receipts.length).toBeGreaterThan(0);
	const rows = await fixture.sql("SELECT seq FROM messages WHERE topic!='system' ORDER BY seq");
	expect(rows).toEqual(receipts.map((seq) => ({ seq })));
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
}, 45000);

it("restores a pre-flip backup when candidate-only initialization changes live data then fails", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const response = await app.post("/api/messages", { topic: "retained", body: "acknowledged before failure" }, cookie);
	const acknowledged = await response.json();
	expect(response.status).toBe(200);
	const source = await readFile(join(import.meta.dirname, "../src/ext/core/schema.ts"), "utf8");
	const changed = source.replace(
		"yield* sql`PRAGMA synchronous = FULL`;",
		`yield* sql\`PRAGMA synchronous = FULL\`;
if (process.env.STATE === "candidate") { yield* sql\`DELETE FROM messages\`; return yield* Effect.die("candidate migration failed"); }`,
	);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const edited = await sourcePut(`${app.url}/api/fs/app/ext/core/schema.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: changed,
	});
	expect(await edited.json()).toMatchObject({ status: "failed", lock: { cutover_in_flight: 0 } });
	await app.ready(cookie);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic!='system'")).toEqual([{ body: acknowledged.body }]);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	expect(await fixture.sql("SELECT good FROM generations ORDER BY n", "boot.db")).toEqual([{ good: 1 }, { good: 0 }]);
}, 20000);

for (const accepted of [false, true])
	it(`recovers boot SIGKILL ${accepted ? "after" : "before"} durable acceptance without losing receipts`, async (test) => {
		const fixture = await conversation(test),
			app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		const posted = await app.post("/api/messages", { topic: "crash", body: "before crash" }, cookie);
		expect(posted.status).toBe(200);
		const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
		const changed = accepted
			? source.replace(
					'else if (body.action === "accepted" || body.action === "live") {',
					'else if (body.action === "accepted" || body.action === "live") { if (body.action === "live" && lifecycle.initial === "candidate") yield* Effect.sleep("3 seconds");',
				)
			: source.replace(
					"yield* migrate(",
					'if (lifecycle.initial === "candidate") yield* Effect.sleep("3 seconds"); yield* migrate(',
				);
		expect(changed).not.toBe(source);
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		const reload = sourcePut(`${app.url}/api/fs/app/server.ts`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test" },
			body: changed,
		}).catch(() => null);
		await expect
			.poll(async () => fixture.sql("SELECT phase FROM cutover", "boot.db"), { timeout: 10000 })
			.toEqual([{ phase: accepted ? "accepted" : "working" }]);
		if (accepted) {
			await expect
				.poll(
					async () => (await app.post("/api/messages", { topic: "crash", body: "after acceptance" }, cookie)).status,
				)
				.toBe(200);
		}
		await app.stop("SIGKILL");
		await reload;
		const resumed = await fixture.launch();
		const again = await resumed.login();
		await resumed.ready(again);
		const rows = await fixture.sql("SELECT body FROM messages WHERE topic!='system' ORDER BY seq");
		expect(rows).toEqual(
			accepted ? [{ body: "before crash" }, { body: "after acceptance" }] : [{ body: "before crash" }],
		);
		expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	}, 25000);

it("repairs a broken first seed through boot editing without an available app", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "broken-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(join(seed, "server.ts"), "invalid source !");
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await expect
		.poll(async () => (await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()).child.state)
		.toBe("failed");
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const repaired = await sourcePut(`${app.url}/api/fs/app/server.ts?release=1`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8"),
	});
	expect(await repaired.json()).toMatchObject({ status: "live", lock: null });
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "repaired", body: "working" }, cookie)).status).toBe(200);
}, 20000);

it("drains admitted slow bodies and reauthenticates queued mutations before forwarding", async (test) => {
	const started = performance.now();
	const phases: Array<{ phase: string; elapsed_ms: number }> = [];
	const phase = (name: string) => phases.push({ phase: name, elapsed_ms: Math.round(performance.now() - started) });
	let traffic: unknown = null;
	let bootOutput = () => "";
	let finished = false;
	let reported = false;
	const responses: { upload?: number; reload?: number; queued?: number; outcome?: unknown } = {};
	const reportFailure = () => {
		if (finished || reported) return;
		reported = true;
		const evidence = JSON.stringify({ phases, traffic, responses, output: bootOutput() })
			.replace(/\/setup is open, code \S+/g, "/setup code [redacted]")
			.replace(/[A-Za-z0-9_-]{43,}/g, "[redacted]")
			.slice(-40000);
		return Effect.runPromise(Console.error("Cutover drain failure evidence", evidence));
	};
	test.onTestFinished(reportFailure);
	phase("launch");
	const fixture = await conversation(test),
		app = await fixture.launch();
	bootOutput = app.output;
	phase("setup");
	await app.setup();
	const cookie = await app.login();
	phase("initial readiness");
	await app.ready(cookie);
	phase("stage source");
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
	expect(
		(
			await sourcePut(`${app.url}/api/fs/app/server.ts?reload=0`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: source,
			})
		).status,
	).toBe(200);
	phase("start held upload");
	const upload = request(`${app.url}/api/messages`, {
		method: "POST",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
	});
	const pending: Promise<unknown>[] = [];
	test.onTestFinished(async () => {
		// Snapshot before teardown settles the pending requests with shutdown responses.
		await reportFailure();
		upload.destroy();
		await app.stop();
		await Promise.allSettled(pending);
	});
	const completed = new Promise<number>((resolve, reject) => {
		upload.on("error", reject);
		upload.on("response", (response) => {
			response.resume();
			response.on("end", () => {
				responses.upload = response.statusCode ?? 0;
				resolve(responses.upload);
			});
			response.on("error", reject);
		});
	});
	pending.push(completed);
	void completed.catch(() => undefined);
	upload.write('{"topic":"held","body":"');
	const state = async () => {
		traffic = (await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()).traffic;
		return traffic;
	};
	await expect.poll(state).toMatchObject({ admitted: 1 });
	phase("reload and freeze");
	const reload = app.post("/api/reload", {}, cookie).then((response) => {
		responses.reload = response.status;
		return response;
	});
	pending.push(reload);
	void reload.catch(() => undefined);
	await expect.poll(state, { timeout: 10000 }).toMatchObject({ frozen: true, admitted: 1 });
	phase("queue mutation");
	const queued = app
		.post("/api/messages", { topic: "held", body: "must be refused after logout" }, cookie)
		.then((response) => {
			responses.queued = response.status;
			return response;
		});
	pending.push(queued);
	void queued.catch(() => undefined);
	await expect.poll(state).toMatchObject({ queued: 1 });
	phase("logout");
	expect((await app.post("/_boot/auth/logout", {}, cookie)).status).toBe(204);
	phase("finish held upload");
	upload.end('acknowledged held body"}');
	expect(await completed).toBe(200);
	phase("await reload");
	responses.outcome = await (await reload).json();
	expect(responses.outcome).toMatchObject({ status: "live" });
	phase("await queued refusal");
	expect((await queued).status).toBe(401);
	phase("verify durable message");
	expect(await fixture.sql("SELECT body FROM messages WHERE topic!='system'")).toEqual([
		{ body: "acknowledged held body" },
	]);
	finished = true;
}, 20000);
