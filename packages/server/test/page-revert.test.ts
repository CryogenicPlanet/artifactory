import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { request } from "node:http";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

// Background app mutations can reserve between calls; retry only the explicit refusal before publication.
const pagePublication = async (send: () => Promise<Response>) => {
	const pending = Schema.Struct({
		error: Schema.Struct({ code: Schema.Literal("publication_pending"), retriable: Schema.Literal(true) }),
	});
	const deadline = Date.now() + 2000;
	for (let attempt = 0; ; attempt++) {
		const response = await send();
		if (response.status !== 503) return response;
		const body = await response.clone().text();
		const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(pending))(body);
		if (Date.now() >= deadline || decoded._tag === "Failure")
			throw new Error(`Page publication refused (${response.status}, attempt ${attempt + 1}): ${body}`);
		await response.body?.cancel();
		await delay(20);
	}
};

it("undoes page paths, batches and retained deletions without taking or disturbing the app lock", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const generations = await fixture.sql("SELECT n FROM generations", "boot.db");
	const write = (content: string | null) =>
		pagePublication(() =>
			fetch(`${app.url}/api/fs/pages/undo/index.md`, {
				method: content === null ? "DELETE" : "PUT",
				headers: { cookie, origin: "https://comms.test" },
				...(content === null ? {} : { body: content }),
			}),
		);
	const read = () => fetch(`${app.url}/api/fs/pages/undo/index.md`, { headers: { cookie } });
	expect((await write("first")).status).toBe(200);
	expect(
		await (await pagePublication(() => app.post("/api/revert", { path: "pages/undo/index.md" }, cookie))).json(),
	).toMatchObject({
		published: true,
	});
	expect((await read()).status).toBe(404);
	expect(await fixture.sql("SELECT * FROM edit_lock", "boot.db")).toEqual([]);
	const createdResponse = await write("second");
	expect(createdResponse.status).toBe(200);
	const created = await createdResponse.json();
	const history = await (await fetch(`${app.url}/api/fs/pages/undo/index.md?history`, { headers: { cookie } })).json();
	const createdVersion = history.items[0].id;
	expect((await write(null)).status).toBe(200);
	const deletedHistory = await (
		await fetch(`${app.url}/api/fs/pages/undo/index.md?history`, { headers: { cookie } })
	).json();
	const deletedVersion = deletedHistory.items[0].id;
	const holderCookie = await app.login();
	expect((await app.post("/api/lock", {}, holderCookie)).status).toBe(200);
	expect(
		(
			await fetch(`${app.url}/api/fs/app/repair.txt?reload=0`, {
				method: "PUT",
				headers: { cookie: holderCookie, origin: "https://comms.test" },
				body: "keep staged",
			})
		).status,
	).toBe(200);
	const lock = await fixture.sql("SELECT * FROM edit_lock", "boot.db");
	for (const [selection, expected] of [
		[{ version: createdVersion }, "second"],
		[{ version: deletedVersion }, null],
		[{ version: createdVersion }, "second"],
		[{ batch: created.batch }, null],
	] as const) {
		expect(await (await pagePublication(() => app.post("/_boot/revert", selection, cookie))).json()).toMatchObject({
			published: true,
		});
		const response = await read();
		expect(expected === null ? response.status : await response.text()).toBe(expected === null ? 404 : expected);
	}
	expect(await fixture.sql("SELECT * FROM edit_lock", "boot.db")).toEqual(lock);
	expect(await fixture.sql("SELECT path, CAST(content AS TEXT) AS content FROM staging", "boot.db")).toEqual([
		{ path: "app/repair.txt", content: "keep staged" },
	]);
	expect(await fixture.sql("SELECT n FROM generations", "boot.db")).toEqual(generations);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
}, 15000);

it("keeps a page undo target across restart and never confuses omitted history bytes with deletion", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const put = (url: string, content: string) =>
		pagePublication(() =>
			fetch(`${url}/api/fs/pages/undo/note.md`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: content,
			}),
		);
	expect((await put(app.url, "before")).status).toBe(200);
	expect((await put(app.url, "after")).status).toBe(200);
	const selection = { path: "pages/undo/note.md" };
	let receiptKey = "";
	for (let attempt = 0; attempt < 5; attempt++) {
		receiptKey = `page-lost-response-${attempt}`;
		const response = await app.post("/api/revert", selection, cookie, receiptKey);
		if (response.status === 200) {
			await response.body?.cancel();
			break;
		}
		// Each prepublication refusal is now a terminal receipt; a fresh operation needs a fresh key.
		expect(await response.json()).toMatchObject({ error: { code: "publication_pending" } });
		expect(attempt).toBeLessThan(4);
		await delay(20);
	}
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(
		await (await pagePublication(() => resumed.post("/api/revert", selection, cookie, receiptKey))).json(),
	).toMatchObject({
		published: true,
	});
	expect(await (await fetch(`${resumed.url}/api/fs/pages/undo/note.md`, { headers: { cookie } })).text()).toBe(
		"before",
	);
	expect(
		await (await resumed.post("/api/revert", { path: "pages/undo/other.md" }, cookie, receiptKey)).json(),
	).toMatchObject({ error: { code: "idempotency_conflict" } });
	expect((await put(resumed.url, "x".repeat(1024 * 1024 + 1))).status).toBe(200);
	expect((await put(resumed.url, "keep")).status).toBe(200);
	expect(await (await pagePublication(() => resumed.post("/api/revert", selection, cookie))).json()).toMatchObject({
		error: { code: "version_unavailable" },
	});
	expect(await (await fetch(`${resumed.url}/api/fs/pages/undo/note.md`, { headers: { cookie } })).text()).toBe("keep");
	expect(await fixture.sql("SELECT * FROM source_changes", "boot.db")).toEqual([]);
}, 20000);

it("reauthenticates held page undo bodies and refuses page symlinks before journaling", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	let cookie = await app.login();
	await app.ready(cookie);
	expect(
		(
			await pagePublication(() =>
				fetch(`${app.url}/api/fs/pages/undo/note.md`, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test" },
					body: "keep",
				}),
			)
		).status,
	).toBe(200);
	const versionsBefore = await fixture.sql("SELECT COUNT(*) AS n FROM versions", "boot.db");
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
	expect((await app.post("/_boot/auth/logout", {}, cookie)).status).toBe(204);
	upload.end('"pages/undo/note.md"}');
	expect(await completed).toBe(401);
	cookie = await app.login();
	expect(await (await fetch(`${app.url}/api/fs/pages/undo/note.md`, { headers: { cookie } })).text()).toBe("keep");
	await writeFile(join(fixture.root, "outside.md"), "outside");
	await fixture.sql("UPDATE versions SET path='pages/undo/link.md' WHERE path='pages/undo/note.md'", "boot.db");
	await symlink(join(fixture.root, "outside.md"), join(fixture.root, "pages/undo/link.md"));
	expect(await (await app.post("/api/revert", { path: "pages/undo/link.md" }, cookie)).json()).toMatchObject({
		error: { code: "invalid_path" },
	});
	expect(await fixture.sql("SELECT * FROM source_changes", "boot.db")).toEqual([]);
	expect(await fixture.sql("SELECT COUNT(*) AS n FROM versions", "boot.db")).toEqual(versionsBefore);
}, 15000);

it("refuses a raw page write before journaling while an app publication is reserved", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const put = () =>
		fetch(`${app.url}/api/fs/pages/reserved.md`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test" },
			body: "written only after release",
		});
	// Claim only an idle allocator, without replacing a real in-flight app reservation.
	await expect
		.poll(() =>
			fixture.sql(
				"UPDATE seq SET pending_id='page-fixture-held' WHERE pending_id IS NULL RETURNING pending_id",
				"boot.db",
			),
		)
		.toEqual([{ pending_id: "page-fixture-held" }]);
	try {
		const response = await put();
		const body = await response.json();
		expect(response.status, JSON.stringify(body)).toBe(503);
		expect(body).toMatchObject({ error: { code: "publication_pending", retriable: true } });
		for (const table of ["versions", "source_batches", "source_changes"])
			expect(await fixture.sql(`SELECT * FROM ${table}`, "boot.db")).toEqual([]);
		await expect(readFile(join(fixture.root, "pages/reserved.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		// A valid app reservation may outlive the former five-attempt (80ms) fixture budget.
		const released = delay(150).then(() =>
			fixture.sql("UPDATE seq SET pending_id=NULL WHERE pending_id='page-fixture-held'", "boot.db"),
		);
		try {
			const accepted = await pagePublication(put);
			expect(accepted.status, await accepted.clone().text()).toBe(200);
		} finally {
			await released;
		}
	} finally {
		await fixture.sql("UPDATE seq SET pending_id=NULL WHERE pending_id='page-fixture-held'", "boot.db");
	}
	expect(await readFile(join(fixture.root, "pages/reserved.md"), "utf8")).toBe("written only after release");
}, 15000);
