import { request } from "node:http";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Console, Effect } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("reverts a file, a whole latest batch and a retained version through cutover without losing messages", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "marker-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const source = await readFile(join(seed, "server.ts"), "utf8");
	const original = source.replace(
		'if (request.url === "/health" && request.method === "GET") return yield* health;',
		'if (request.url === "/api/source-marker") return HttpServerResponse.text("comms: message API ready."); if (request.url === "/health" && request.method === "GET") return yield* health;',
	);
	expect(original).not.toBe(source);
	await writeFile(join(seed, "server.ts"), original);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const changed = original.replace("comms: message API ready.", "comms: reverted API ready.");
	expect(changed).not.toBe(original);
	const put = (path: string, content: string) =>
		fetch(`${app.url}/api/fs/${path}?reload=0`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test" },
			body: content,
		});
	const root = async () => (await fetch(`${app.url}/api/source-marker`, { headers: { cookie } })).text();
	expect((await app.post("/api/revert", {}, cookie)).status).toBe(423);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	expect((await put("app/server.ts", changed)).status).toBe(200);
	expect((await put("app/extra.txt", "first creation")).status).toBe(200);
	expect(await (await app.post("/api/reload", {}, cookie)).json()).toMatchObject({ status: "live" });
	const history = await (await fetch(`${app.url}/api/fs/app/server.ts?history`, { headers: { cookie } })).json();
	const version = history.items[0].id;
	const batch = history.items[0].batch;
	expect(await root()).toContain("reverted API ready");
	expect((await app.post("/api/messages", { topic: "revert", body: "keep across source undo" }, cookie)).status).toBe(
		200,
	);
	expect(await (await app.post("/_boot/revert", { path: "app/server.ts" }, cookie)).json()).toMatchObject({
		status: "live",
	});
	expect(await root()).toContain("message API ready");
	expect((await fetch(`${app.url}/api/fs/app/extra.txt`, { headers: { cookie } })).status).toBe(200);
	expect(await (await app.post("/api/revert", { version }, cookie)).json()).toMatchObject({ status: "live" });
	expect(await root()).toContain("reverted API ready");
	expect(await (await app.post("/api/revert", { batch }, cookie)).json()).toMatchObject({ status: "live" });
	expect(await root()).toContain("message API ready");
	expect((await fetch(`${app.url}/api/fs/app/extra.txt`, { headers: { cookie } })).status).toBe(404);
	expect(await (await app.post("/api/revert", {}, cookie)).json()).toMatchObject({ status: "live" });
	expect(await root()).toContain("reverted API ready");
	expect((await fetch(`${app.url}/api/fs/app/extra.txt`, { headers: { cookie } })).status).toBe(200);
	expect(await fixture.sql("SELECT body FROM messages")).toEqual([{ body: "keep across source undo" }]);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
}, 45000);

it("refuses ambiguous selectors, unavailable history and unrelated staging without changing source", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	for (const input of [{ path: "app/server.ts", batch: "x" }, { version: 0 }, { path: "app/../boot.db" }])
		expect((await app.post("/api/revert", input, cookie)).status).toBe(400);
	expect((await app.post("/api/revert", { generation: 0 }, cookie)).status).toBe(400);
	const invalidRestore = await app.post("/api/revert", { withDb: true }, cookie);
	expect(invalidRestore.status).toBe(400);
	expect(await invalidRestore.json()).toMatchObject({ error: { code: "revert_selection_invalid" } });
	const put = (content: string) =>
		fetch(`${app.url}/api/fs/app/large.txt`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test" },
			body: content,
		});
	expect(await (await put("x".repeat(1024 * 1024 + 1))).json()).toMatchObject({ status: "live" });
	expect(await (await put("small")).json()).toMatchObject({ status: "live" });
	expect(await (await app.post("/api/revert", { path: "app/large.txt" }, cookie)).json()).toMatchObject({
		error: { code: "version_unavailable" },
	});
	expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual([]);
	expect(
		(
			await fetch(`${app.url}/api/fs/app/held.txt?reload=0`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: "unrelated repair",
			})
		).status,
	).toBe(200);
	expect(await (await app.post("/api/revert", { version: 1 }, cookie)).json()).toMatchObject({
		error: { code: "staging_not_empty" },
	});
	const history = await (await fetch(`${app.url}/api/fs/app/large.txt?history`, { headers: { cookie } })).json();
	expect(await (await app.post("/api/revert", { version: history.items[0].id }, cookie)).json()).toMatchObject({
		error: { code: "staging_not_empty" },
	});
	expect(await fixture.sql("SELECT path, CAST(content AS TEXT) AS content FROM staging", "boot.db")).toEqual([
		{ path: "app/held.txt", content: "unrelated repair" },
	]);
	expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 0 }]);
}, 20000);

it("reauthenticates a held revert body and fences a replaced lock before staging undo", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	let cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	expect(
		await (
			await fetch(`${app.url}/api/fs/app/note.txt`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: "retain",
			})
		).json(),
	).toMatchObject({ status: "live" });
	for (const revoke of [false, true]) {
		const upload = request(`${app.url}/api/revert`, {
			method: "POST",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
		});
		test.onTestFinished(() => {
			upload.destroy();
		});
		const completed = new Promise<number>((resolve, reject) => {
			upload.on("error", reject);
			upload.on("response", (response) => {
				response.resume();
				response.on("end", () => resolve(response.statusCode ?? 0));
			});
		});
		upload.write('{"path":');
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (revoke) expect((await app.post("/_boot/auth/logout", {}, cookie)).status).toBe(204);
		else {
			expect(
				(await fetch(`${app.url}/api/lock`, { method: "DELETE", headers: { cookie, origin: "https://comms.test" } }))
					.status,
			).toBe(200);
			expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		}
		upload.end('"app/note.txt"}');
		expect(await completed).toBe(revoke ? 401 : 423);
		expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual([]);
		if (revoke) cookie = await app.login();
	}
	expect(await (await fetch(`${app.url}/api/fs/app/note.txt`, { headers: { cookie } })).text()).toBe("retain");
}, 15000);

for (const input of [{}, { path: "app/note.txt" }])
	it(`replays the exact ${"path" in input ? "path" : "latest-batch"} undo outcome across restart without replacing later edits`, async (test) => {
		const started = performance.now();
		const phases: Array<{ phase: string; at_ms: number }> = [];
		const phase = (name: string) => phases.push({ phase: name, at_ms: Math.round(performance.now() - started) });
		test.onTestFinished(() => Effect.runPromise(Console.error("Source undo replay phases", input, phases)));
		phase("setup_start");
		const fixture = await conversation(test),
			app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		phase("initial_live");
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		expect(
			await (
				await fetch(`${app.url}/api/fs/app/note.txt`, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test" },
					body: "first creation",
				})
			).json(),
		).toMatchObject({ status: "live" });
		phase("first_edit_live");
		const replies = await Promise.all([0, 1].map(() => app.post("/api/revert", input, cookie, "lost-revert-response")));
		phase("undo_responses");
		const first = await replies[0]?.json();
		expect(await replies[1]?.json()).toEqual(first);
		expect(first).toMatchObject({ status: "live" });
		// A later edit and released lock must survive replay, including after reboot.
		expect(
			await (
				await fetch(`${app.url}/api/fs/app/note.txt`, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test" },
					body: "later edit",
				})
			).json(),
		).toMatchObject({ status: "live" });
		expect(
			(await fetch(`${app.url}/api/lock`, { method: "DELETE", headers: { cookie, origin: "https://comms.test" } }))
				.status,
		).toBe(200);
		phase("later_edit_live_lock_released");
		const generations = await fixture.sql("SELECT n FROM generations", "boot.db");
		await app.stop();
		phase("boot_stopped");
		const resumed = await fixture.launch();
		await resumed.ready(cookie);
		phase("restarted_live");
		expect(await (await fetch(`${resumed.url}/api/fs/app/note.txt`, { headers: { cookie } })).text()).toBe(
			"later edit",
		);
		expect(await (await resumed.post("/api/revert", input, cookie, "lost-revert-response")).json()).toEqual(first);
		expect(await fixture.sql("SELECT n FROM generations", "boot.db")).toEqual(generations);
		expect(await (await fetch(`${resumed.url}/api/fs/app/note.txt`, { headers: { cookie } })).text()).toBe(
			"later edit",
		);
		expect(
			await (await resumed.post("/api/revert", { version: 1 }, cookie, "lost-revert-response")).json(),
		).toMatchObject({ error: { code: "idempotency_conflict" } });
		expect(
			await fixture.sql("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'source-revert-result:%'", "boot.db"),
		).toEqual([{ n: 1 }]);
		phase("assertions_complete");
		// Three real cutovers plus boot restart exceeded 20s in Linux CI; each readiness/production deadline stays unchanged.
	}, 45000);
