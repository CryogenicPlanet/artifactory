import { sourcePut } from "./fixtures/source-put.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pagePublicationQueue } from "./fixtures/page-publication-queue.ts";

it.for(["append", "crash", "logout", "cancel"] as const)(
	"queues raw page publication behind a real app reservation (%s)",
	{ timeout: 30000 },
	async (mode, test) => {
		const fixture = await pagePublicationQueue(test),
			app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		const target = `${app.url}/api/fs/pages/queued.md`;
		const headers = { cookie, origin: "https://comms.test" };
		expect((await sourcePut(target, { method: "PUT", headers, body: "original" })).status).toBe(200);
		const history = await fixture.sql("SELECT * FROM source_batches ORDER BY id", "boot.db");
		const current = await fetch(target, { headers });
		expect(current.status).toBe(200);
		const baseVersion = current.headers.get("x-chirp-base-version");
		if (!baseVersion) throw Error("Missing source base version");
		await current.arrayBuffer();
		await fixture.hold();
		const mutation = app.post("/api/messages", { topic: "queue", body: "held mutation" }, cookie).then(
			(response) => response.status,
			() => 0,
		);
		await expect.poll(fixture.reserved, { timeout: 5000 }).not.toBe("");
		const reservation = await fixture.sql("SELECT pending_id FROM seq", "boot.db");
		expect(reservation).toEqual([{ pending_id: expect.any(String) }]);
		const controller = new AbortController();
		test.onTestFinished(() => controller.abort());
		let completed = false;
		const page = fetch(`${target}?baseVersion=${encodeURIComponent(baseVersion)}`, {
			method: "PUT",
			headers,
			body: "queued update",
			signal: controller.signal,
		}).then(
			(response) => {
				completed = true;
				return response.status;
			},
			() => {
				completed = true;
				return 0;
			},
		);
		await expect.poll(fixture.waiting, { timeout: 5000 }).toBe("waiting");
		expect(completed).toBe(false);
		expect(await fixture.sql("SELECT * FROM source_batches ORDER BY id", "boot.db")).toEqual(history);
		expect(await readFile(join(fixture.root, "pages/queued.md"), "utf8")).toBe("original");
		if (mode === "logout") expect((await app.post("/_boot/auth/logout", {}, cookie)).status).toBe(204);
		if (mode === "cancel") {
			controller.abort();
			expect(await page).toBe(0);
		}
		if (mode === "crash") process.kill(Number(await fixture.reserved()), "SIGKILL");
		await fixture.release();
		if (mode !== "crash") expect(await mutation).toBe(200);
		else {
			await mutation;
			await expect
				.poll(() => fixture.sql("SELECT pending_id FROM seq", "boot.db"), { timeout: 10000 })
				.toEqual([{ pending_id: null }]);
			expect(await fixture.sql("SELECT body FROM messages WHERE topic='queue'")).toEqual([]);
		}
		expect(await page).toBe(mode === "cancel" ? 0 : mode === "logout" ? 401 : 200);
		const rejected = mode === "logout" || mode === "cancel";
		expect(await readFile(join(fixture.root, "pages/queued.md"), "utf8")).toBe(rejected ? "original" : "queued update");
		if (rejected) expect(await fixture.sql("SELECT * FROM source_batches ORDER BY id", "boot.db")).toEqual(history);
		else
			expect(await fixture.sql("SELECT COUNT(*) count FROM versions WHERE path='pages/queued.md'", "boot.db")).toEqual([
				{ count: 2 },
			]);
		const again = mode === "logout" ? await app.login() : cookie;
		expect(
			(await sourcePut(target, { method: "PUT", headers: { ...headers, cookie: again }, body: "next editor" })).status,
		).toBe(200);
		// A late canceled fiber must not leave an intermediate version behind the next editor.
		expect(await fixture.sql("SELECT COUNT(*) count FROM versions WHERE path='pages/queued.md'", "boot.db")).toEqual([
			{ count: rejected ? 2 : 3 },
		]);
	},
);
