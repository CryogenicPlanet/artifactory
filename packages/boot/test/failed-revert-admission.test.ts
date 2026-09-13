import { kernelProtocolHeader, writerEpochHeader } from "@comms/protocol/headers";
import { sourcePut } from "./fixtures/source-put.ts";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it, type TestContext } from "vitest";
import { seedSession, sessionFetch } from "./fixtures/session.ts";

const execute = promisify(execFile);
async function fixture(test: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-failed-recovery-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "seed"));
	await mkdir(join(root, "seed-pages"));
	await writeFile(join(root, "seed-pages/index.md"), "preserved page");
	await writeFile(
		join(root, "seed/child.ts"),
		`
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(request) {
if (request.headers.get('x-boot-secret') !== process.env.BOOT_SECRET) return new Response(null,{status:403});
return new Response('original',{headers:{'${writerEpochHeader}':process.env.WRITER_EPOCH??'','${kernelProtocolHeader}':'2'}});
}}); console.log('COMMS_CHILD_PORT='+server.port);`,
	);
	const sql = async (statement: string, store = "boot.db"): Promise<unknown> =>
		JSON.parse(
			(await execute("bun", [join(import.meta.dirname, "fixtures/store.ts"), join(root, "data", store), statement]))
				.stdout,
		);
	const start = async (ready = true) => {
		const processHandle = spawn("bun", [join(import.meta.dirname, "fixtures/failed-recovery-launcher.ts")], {
			env: { ...process.env, TEST_ROOT: root },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const capture = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-16384);
		};
		processHandle.stdout.on("data", capture);
		processHandle.stderr.on("data", capture);
		const stop = async () => {
			if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
			const exited = once(processHandle, "exit");
			processHandle.kill("SIGTERM");
			await Promise.race([exited, delay(6000)]);
			if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGKILL");
			await exited;
		};
		test.onTestFinished(stop);
		let url = "";
		await expect
			.poll(
				() => {
					if (processHandle.exitCode !== null) throw new Error(output);
					url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
					return url;
				},
				{ timeout: 5000 },
			)
			.not.toBe("");
		const session = await seedSession(join(root, "data"));
		const call = sessionFetch(session.cookie);
		const status = async (): Promise<unknown> => (await call(`${url}/_boot/status`)).json();
		if (ready) await expect.poll(async () => (await call(url)).status, { timeout: 10000 }).toBe(200);
		return { url, session, call, status, stop };
	};
	return { root, sql, start };
}

it.for(["app", "pages"])(
	"admits human %s revert when unrelated recovery still fails, preserving data and borrowed staging",
	{ timeout: 30000 },
	async (kind, test) => {
		const env = await fixture(test);
		const first = await env.start();
		const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
		expect((await first.call(`${first.url}/_boot/lock`, post)).status).toBe(200);
		const original = await readFile(join(env.root, "data/app/child.ts"), "utf8");
		expect(
			(
				await sourcePut(
					`${first.url}/_boot/fs/app/child.ts`,
					{ method: "PUT", body: original.replace("'original'", "'changed'") },
					first.call,
				)
			).status,
		).toBe(200);
		if (kind === "pages")
			expect(
				(await sourcePut(`${first.url}/_boot/fs/pages/index.md`, { method: "PUT", body: "changed page" }, first.call))
					.status,
			).toBe(200);

		await env.sql("CREATE TABLE preserved_message(body TEXT)", "comms.db");
		await env.sql("INSERT INTO preserved_message VALUES('acknowledged')", "comms.db");
		await env.sql(
			"INSERT INTO staging(lock_id,path,content,sha,at) SELECT id,'app/preserved.ts',CAST('staged' AS BLOB),'unused',0 FROM edit_lock",
		);
		await first.stop();
		await env.sql(
			"INSERT INTO settings(key,value) VALUES('source-revert-result:broken','invalid-json-private-detail')",
		);
		const restarted = await env.start(false);
		await expect.poll(restarted.status, { timeout: 10000 }).toMatchObject({ child: { state: "failed" } });
		const request = {
			...post,
			headers: { ...post.headers, "idempotency-key": "failed-phase-revert" },
			body: JSON.stringify({ path: kind === "app" ? "app/child.ts" : "pages/index.md" }),
		};
		for (const headers of [
			{ "content-type": "application/json" },
			{ "content-type": "application/json", cookie: restarted.session.cookie, origin: "https://wrong.test" },
		]) {
			const denied = await fetch(`${restarted.url}/_boot/revert`, { ...request, headers });
			expect([401, 403]).toContain(denied.status);
		}
		const result = await restarted.call(`${restarted.url}/_boot/revert`, request);
		expect(await result.json()).toMatchObject({
			...(kind === "app" ? { status: "live" } : { published: true }),
			revert_committed: true,
			recovery: { status: "failed" },
		});
		const replay = await restarted.call(`${restarted.url}/_boot/revert`, request);
		expect(await replay.json()).toMatchObject({ revert_committed: true, recovery: { status: "failed" } });
		expect(result.status).toBe(200);
		expect(await readFile(join(env.root, "data/app/child.ts"), "utf8")).toBe(
			kind === "app" ? original : original.replace("'original'", "'changed'"),
		);
		expect(await readFile(join(env.root, "data/pages/index.md"), "utf8")).toBe("preserved page");
		expect(await env.sql("SELECT body FROM preserved_message", "comms.db")).toEqual([{ body: "acknowledged" }]);
		expect(await env.sql("SELECT CAST(content AS TEXT) AS content FROM staging")).toEqual([{ content: "staged" }]);
		expect(await env.sql("SELECT value FROM settings WHERE key='source-revert-result:broken'")).toEqual([
			{ value: "invalid-json-private-detail" },
		]);
	},
);

it("admits lock repair beside a stranded page-only publication without consuming its evidence", async (test) => {
	const env = await fixture(test);
	const first = await env.start();
	await first.stop();
	await env.sql("INSERT INTO source_batches VALUES('page',NULL,'boot',0,'publishing')");
	await env.sql(
		"INSERT INTO source_changes(batch,path,before,before_sha,before_mode,desired,desired_sha,desired_mode) VALUES('page','pages/index.md',CAST('before' AS BLOB),'not-current',420,CAST('after' AS BLOB),'not-current-either',420)",
	);
	const before = await env.sql("SELECT * FROM source_changes");
	await env.sql("INSERT INTO settings(key,value) VALUES('source-revert-result:broken','invalid-json')");
	const restarted = await env.start(false);
	await expect
		.poll(restarted.status, { timeout: 10000 })
		.toMatchObject({ child: { state: "failed" }, source_recovery_error: expect.any(String) });
	const result = await restarted.call(`${restarted.url}/_boot/lock`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	expect(result.status).toBe(503);
	expect(await result.json()).toMatchObject({
		lock_committed: true,
		lock: { holder_family: restarted.session.id },
		recovery: { status: "failed" },
	});
	expect(await env.sql("SELECT * FROM source_changes")).toEqual(before);
	expect(await env.sql("SELECT state FROM source_batches WHERE id='page'")).toEqual([{ state: "publishing" }]);
	expect(await readFile(join(env.root, "data/pages/index.md"), "utf8")).toBe("preserved page");
});

it("refuses failed-phase page revert until every prior database owner has positive closure evidence", async (test) => {
	const env = await fixture(test);
	const first = await env.start();
	expect(
		(await sourcePut(`${first.url}/_boot/fs/pages/index.md`, { method: "PUT", body: "changed page" }, first.call))
			.status,
	).toBe(200);
	await first.stop();
	const receipt = join(env.root, "data/attempts/late-owner.closed");
	await env.sql(
		`INSERT INTO child_attempts(id,generation,receipt,opened,closed) VALUES('late-owner',1,'${receipt}',1,0)`,
	);
	const before = await env.sql("SELECT * FROM versions");
	const restarted = await env.start(false);
	await expect.poll(restarted.status, { timeout: 12000 }).toMatchObject({
		child: { state: "failed" },
		source_recovery_error: expect.stringContaining("child_closure_unproven"),
	});
	const response = await restarted.call(`${restarted.url}/_boot/revert`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: '{"path":"pages/index.md"}',
	});
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ error: { code: "child_closure_unproven" } });
	expect(await env.sql("SELECT closed FROM child_attempts WHERE id='late-owner'")).toEqual([{ closed: 0 }]);
	expect(await env.sql("SELECT * FROM versions")).toEqual(before);
	expect(await readFile(join(env.root, "data/pages/index.md"), "utf8")).toBe("changed page");
}, 20000);
