import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { seedSession, sessionFetch } from "./fixtures/session.ts";

const execute = promisify(execFile);
const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
async function fixture(test: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-pages-http-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "seed"));
	await mkdir(join(root, "seed-pages"));
	await writeFile(join(root, "seed-pages/index.md"), "seed page");
	await writeFile(
		join(root, "seed/child.ts"),
		`
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(request) {
if (request.headers.get('x-boot-secret') !== process.env.BOOT_SECRET) return new Response(null,{status:403});
return new Response(process.env.PAGES_DIRECTORY,{headers:{'x-comms-writer-epoch':process.env.WRITER_EPOCH??'','x-comms-kernel-protocol':'2'}});
}}); console.log('COMMS_CHILD_PORT='+server.port);`,
	);
	const sql = async (statement: string) =>
		decode(
			(
				await execute("bun", [join(import.meta.dirname, "fixtures/store.ts"), join(root, "data/boot.db"), statement])
			).stdout.trim(),
		);
	const start = async () => {
		const child = spawn("bun", [join(import.meta.dirname, "fixtures/pages-launcher.ts")], {
			env: { ...process.env, TEST_ROOT: root },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const capture = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-16384);
		};
		child.stdout.on("data", capture);
		child.stderr.on("data", capture);
		const stop = async () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await Promise.race([exited, delay(6000)]);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
		};
		test.onTestFinished(stop);
		let url = "";
		await expect
			.poll(
				() => {
					if (child.exitCode !== null) throw new Error(output);
					url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
					return url;
				},
				{ timeout: 5000 },
			)
			.not.toBe("");
		const session = await seedSession(join(root, "data"));
		const call = sessionFetch(session.cookie);
		await expect.poll(async () => (await call(url)).status, { timeout: 5000 }).toBe(200);
		return { url, call, session, stop };
	};
	return { root, sql, start };
}

it("seeds once, passes an absolute pages root, publishes without an app lock or swap, and preserves pages on restart", async (test) => {
	const env = await fixture(test),
		app = await env.start();
	expect(await (await app.call(app.url)).text()).toBe(join(env.root, "data/pages"));
	expect(await readFile(join(env.root, "data/pages/index.md"), "utf8")).toBe("seed page");
	const before = await env.sql("SELECT n,status FROM generations");
	const lock = await app.call(`${app.url}/api/lock`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ note: "independent app editor" }),
	});
	expect(lock.status).toBe(200);
	const other = sessionFetch((await seedSession(join(env.root, "data"))).cookie);
	const lockBefore = await env.sql("SELECT * FROM edit_lock");
	for (const content of ["first", "updated"]) {
		const result = await other(`${app.url}/api/fs/pages/topic/index.md`, { method: "PUT", body: content });
		expect(result.status).toBe(200);
		expect(await result.json()).toMatchObject({ published: true, batch: expect.any(String) });
	}
	expect(await (await other(`${app.url}/_boot/fs/pages/topic/index.md`)).text()).toBe("updated");
	expect(await env.sql("SELECT n,status FROM generations")).toEqual(before);
	expect(await env.sql("SELECT * FROM edit_lock")).toEqual(lockBefore);
	expect(
		await env.sql(
			"SELECT CAST(previous_content AS TEXT) AS before,CAST(content AS TEXT) AS after FROM versions ORDER BY id",
		),
	).toEqual([
		{ before: null, after: "first" },
		{ before: "first", after: "updated" },
	]);
	expect((await other(`${app.url}/api/fs/pages/index.md`, { method: "DELETE" })).status).toBe(200);
	await app.stop();
	await writeFile(join(env.root, "seed-pages/index.md"), "new seed must not replace deleted page");
	const restarted = await env.start();
	expect((await restarted.call(`${restarted.url}/api/fs/pages/index.md`)).status).toBe(404);
	expect(await (await restarted.call(`${restarted.url}/api/fs/pages/topic/index.md`)).text()).toBe("updated");
});

it("rejects anonymous, cross-origin, oversized, unsafe paths and revoked held-body page writes", async (test) => {
	const env = await fixture(test),
		app = await env.start();
	const target = `${app.url}/api/fs/pages/secret.md`;
	expect((await fetch(target, { method: "PUT", body: "unauthorized" })).status).toBe(401);
	expect((await fetch(`${app.url}/p/index.md`)).status).toBe(401);
	expect(
		(
			await fetch(target, {
				method: "PUT",
				headers: { cookie: app.session.cookie, origin: "https://evil.test" },
				body: "bad",
			})
		).status,
	).toBe(403);
	for (const query of ["reload=0", "check=1", "release=1"])
		expect((await app.call(`${target}?${query}`, { method: "PUT", body: "bad" })).status).toBe(400);
	expect((await app.call(target, { method: "PUT", body: "x".repeat(8_388_609) })).status).toBe(400);
	await symlink(join(env.root, "seed-pages"), join(env.root, "data/pages/link"));
	for (const path of ["pages/link/index.md", "pages/%2e%2e%2fboot.db", "pages/%5cboot.db"])
		expect((await app.call(`${app.url}/api/fs/${path}`, { method: "PUT", body: "bad" })).status).toBe(400);
	const pending = request(target, {
		method: "PUT",
		headers: { cookie: app.session.cookie, origin: "https://comms.test", "content-length": "4" },
	});
	const response = new Promise<number | undefined>((resolve, reject) => {
		pending.on("response", (r) => {
			r.resume();
			r.on("end", () => resolve(r.statusCode));
		});
		pending.on("error", reject);
	});
	pending.write("a");
	await delay(100);
	expect((await app.call(`${app.url}/_boot/auth/logout`, { method: "POST", body: "{}" })).status).toBe(204);
	pending.end("bcd");
	expect(await response).toBe(401);
	expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
	await expect(readFile(join(env.root, "data/pages/secret.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("recovers a page publication with failed history completion, without reseeding an existing tree", async (test) => {
	const env = await fixture(test);
	await mkdir(join(env.root, "data/pages"), { recursive: true });
	await writeFile(join(env.root, "data/pages/kept.txt"), "existing");
	const app = await env.start();
	expect((await app.call(`${app.url}/api/fs/pages/index.md`)).status).toBe(404);
	await env.sql(
		"CREATE TRIGGER fail_page_history BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT,'test history failure'); END",
	);
	expect((await app.call(`${app.url}/api/fs/pages/kept.txt`, { method: "PUT", body: "published" })).status).toBe(503);
	expect(await env.sql("SELECT state FROM source_batches")).toEqual([{ state: "publishing" }]);
	await app.stop();
	await env.sql("DROP TRIGGER fail_page_history");
	const restarted = await env.start();
	expect(await (await restarted.call(`${restarted.url}/api/fs/pages/kept.txt`)).text()).toBe("published");
	expect(await env.sql("SELECT state FROM source_batches")).toEqual([{ state: "published" }]);
	expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
});

it.for([true, false])(
	"keeps saved-good app recovery available during a page journal conflict (initialized=%s)",
	async (initialized, test) => {
		const env = await fixture(test),
			app = await env.start();
		await env.sql(
			"CREATE TRIGGER fail_page_history BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT,'test history failure'); END",
		);
		expect((await app.call(`${app.url}/api/fs/pages/index.md`, { method: "PUT", body: "desired" })).status).toBe(503);
		await app.stop();
		await writeFile(join(env.root, "data/pages/index.md"), "external conflicting bytes");
		await env.sql("DROP TRIGGER fail_page_history");
		if (!initialized) await env.sql("DELETE FROM settings WHERE key='pages_seeded'");
		const restarted = await env.start();
		expect((await restarted.call(restarted.url)).status).toBe(200);
		expect(await (await restarted.call(`${restarted.url}/_boot/status`)).json()).toMatchObject({
			source_recovery_error: expect.stringContaining("external_conflict"),
		});
		expect(await readFile(join(env.root, "data/pages/index.md"), "utf8")).toBe("external conflicting bytes");
	},
);

it("discards a prepared page when its session is revoked before journal admission", async (test) => {
	const env = await fixture(test),
		app = await env.start();
	await writeFile(join(env.root, "data/pages/held.md"), "original");
	await writeFile(join(env.root, "pause-page"), "hold");
	const pending = app.call(`${app.url}/api/fs/pages/held.md`, { method: "PUT", body: "must not publish" });
	await expect
		.poll(async () => readFile(join(env.root, "page-captured"), "utf8").catch(() => ""), { timeout: 5000 })
		.toBe("ready");
	await env.sql(`DELETE FROM sessions WHERE id='${app.session.id}'`);
	await rm(join(env.root, "pause-page"));
	expect((await pending).status).toBe(401);
	expect(await readFile(join(env.root, "data/pages/held.md"), "utf8")).toBe("original");
	expect(await env.sql("SELECT * FROM source_batches")).toEqual([]);
	const other = sessionFetch((await seedSession(join(env.root, "data"))).cookie);
	expect((await other(`${app.url}/api/fs/pages/held.md`, { method: "PUT", body: "next editor" })).status).toBe(200);
	expect(await readFile(join(env.root, "data/pages/held.md"), "utf8")).toBe("next editor");
});

it("serves fs-scoped directory listings on both aliases with holder overlay and safe path handling", async (test) => {
	const env = await fixture(test),
		app = await env.start();
	const other = sessionFetch((await seedSession(join(env.root, "data"))).cookie);
	const directory = `${app.url}/api/fs/app/`;
	const token = randomBytes(32).toString("base64url");
	const hash = createHash("sha256").update(token).digest("hex");
	await env.sql(
		`INSERT INTO tokens (id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at) VALUES ('browse-token','browse-pair','browse-family','codex','access','${hash}','reader','["read"]',9999999999999,0)`,
	);
	expect((await fetch(directory, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
	await env.sql(`UPDATE tokens SET scopes='["fs"]' WHERE id='browse-token'`);
	expect((await fetch(directory, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
	expect((await app.call(directory, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);

	expect((await fetch(directory)).status).toBe(401);
	expect(
		(
			await app.call(`${app.url}/api/lock`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			})
		).status,
	).toBe(200);
	expect(
		(await app.call(`${app.url}/api/fs/app/new/deep/test.ts?reload=0`, { method: "PUT", body: "new" })).status,
	).toBe(200);
	const holder = await app.call(directory);
	expect(holder.headers.get("cache-control")).toBe("no-store");
	expect(await holder.json()).toMatchObject({ items: expect.arrayContaining([{ name: "new", type: "directory" }]) });
	expect(await (await other(directory)).json()).not.toMatchObject({
		items: expect.arrayContaining([{ name: "new", type: "directory" }]),
	});
	expect(await (await app.call(`${app.url}/_boot/fs/app/new/deep`)).json()).toEqual({
		items: [{ name: "test.ts", type: "file" }],
	});
	expect(await (await app.call(`${app.url}/api/fs/pages/`)).json()).toEqual({
		items: [{ name: "index.md", type: "file" }],
	});
	expect(await (await app.call(`${app.url}/api/fs/pages/index.md`)).text()).toBe("seed page");
	for (const path of ["pages/%2e%2e%2fboot.db", "app//", "pages/.comms-private.tmp", "app/node_modules/"])
		expect((await app.call(`${app.url}/api/fs/${path}`)).status).toBe(400);
	expect((await app.call(`${app.url}/api/fs/app/missing/`)).status).toBe(404);
});
