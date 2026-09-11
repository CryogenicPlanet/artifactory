import { request } from "node:http";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

for (const expires of [false, true])
	it(`drain deadline ${expires ? "refuses before backup and resumes the same child" : "does not consume candidate health time"}`, async (test) => {
		const fixture = await conversation(test);
		const seed = join(fixture.root, "seed");
		await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
		// Give this test's admitted upload a longer body deadline than boot's drain.
		const bodySource = await readFile(join(seed, "request-schema.ts"), "utf8");
		expect(bodySource).toContain('Effect.timeout("5 seconds")');
		await writeFile(
			join(seed, "request-schema.ts"),
			bodySource.replace('Effect.timeout("5 seconds")', 'Effect.timeout("30 seconds")'),
		);
		const app = await fixture.launch(join(seed, "server.ts"));
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
		const changed = expires
			? source
			: source.replace(
					"yield* initialize;\n\t\t\t\tyield* migrate",
					'yield* initialize; if (lifecycle.initial === "candidate") yield* Effect.sleep("4 seconds");\n\t\t\t\tyield* migrate',
				);
		if (!expires) expect(changed).not.toBe(source);
		expect(
			(
				await fetch(`${app.url}/api/fs/app/server.ts?reload=0`, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test" },
					body: changed,
				})
			).status,
		).toBe(200);
		const state = async () => await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
		const before = await state();
		const upload = request(`${app.url}/api/messages`, {
			method: "POST",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
		});
		const pending: Promise<unknown>[] = [];
		test.onTestFinished(async () => {
			upload.destroy();
			await app.stop();
			await Promise.allSettled(pending);
		});
		const completed = new Promise<number>((resolve, reject) => {
			upload.on("error", reject);
			upload.on("response", (response) => {
				response.resume();
				response.on("end", () => resolve(response.statusCode ?? 0));
				response.on("error", reject);
			});
		});
		pending.push(completed);
		void completed.catch(() => undefined);
		upload.write('{"topic":"deadline","body":"');
		await expect.poll(async () => (await state()).traffic).toMatchObject({ admitted: 1 });
		const reload = app.post("/api/reload", {}, cookie);
		pending.push(reload);
		void reload.catch(() => undefined);
		await expect
			.poll(async () => (await state()).traffic, { timeout: 10000 })
			.toMatchObject({ frozen: true, admitted: 1 });
		if (expires) {
			const result = await reload;
			expect(result.status).toBe(503);
			expect(await result.json()).toMatchObject({ error: { code: "freeze_timeout", retriable: true } });
			expect(await fixture.sql("SELECT id FROM backups WHERE reason='pre-flip'", "boot.db")).toEqual([]);
			expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
			expect((await state()).child.pid).toBe(before.child.pid);
			expect((await state()).traffic).toMatchObject({ frozen: false });
			upload.end('survives timeout"}');
			expect(await completed).toBe(200);
			expect((await app.post("/api/messages", { topic: "deadline", body: "after timeout" }, cookie)).status).toBe(200);
			expect(await fixture.sql("SELECT body FROM messages ORDER BY seq")).toEqual([
				{ body: "survives timeout" },
				{ body: "after timeout" },
			]);
		} else {
			await delay(7000);
			upload.end('survives slow drain"}');
			expect(await completed).toBe(200);
			const result = await (await reload).json();
			expect(result).toMatchObject({ status: "live" });
			expect(result.freeze_ms).toBeGreaterThan(10000);
			expect(await fixture.sql("SELECT body FROM messages")).toEqual([{ body: "survives slow drain" }]);
		}
	}, 30000);
