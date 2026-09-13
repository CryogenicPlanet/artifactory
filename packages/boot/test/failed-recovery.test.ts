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
return new Response('original',{headers:{'x-chirp-writer-epoch':process.env.WRITER_EPOCH??'','x-chirp-kernel-protocol':'2'}});
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

it("retries Failed keeper recovery from human source repair without losing data or borrowed staging", async (test) => {
	const env = await fixture(test);
	const first = await env.start();
	const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
	expect((await first.call(`${first.url}/_boot/lock`, post)).status).toBe(200);
	const original = await readFile(join(env.root, "data/app/child.ts"), "utf8");
	expect(
		(
			await sourcePut(
				`${first.url}/_boot/fs/app/child.ts`,
				{
					method: "PUT",
					body: original.replace("'original'", "'changed'"),
				},
				first.call,
			)
		).status,
	).toBe(200);
	await env.sql("CREATE TABLE preserved_message(body TEXT)", "comms.db");
	await env.sql("INSERT INTO preserved_message VALUES('acknowledged')", "comms.db");
	await first.stop();
	// The keeper evidence arrives after startup's bounded check; absence alone never proves closure.
	const receipt = join(env.root, "data/attempts/late-owner.closed");
	await env.sql(
		`INSERT INTO child_attempts(id,generation,receipt,opened,closed) VALUES('late-owner',2,'${receipt}',1,0)`,
	);
	await env.sql("UPDATE edit_lock SET cutover_in_flight=1,reset_pin=1");
	await env.sql(
		"INSERT INTO staging(lock_id,path,content,sha,at) SELECT id,'app/preserved.ts',CAST('staged' AS BLOB),'unused',0 FROM edit_lock",
	);
	const held = await env.sql("SELECT id,holder_family,cutover_in_flight,reset_pin FROM edit_lock");
	const restarted = await env.start(false);
	await expect.poll(restarted.status, { timeout: 12000 }).toMatchObject({
		child: { state: "failed" },
		source_recovery_error: expect.stringContaining("child_closure_unproven"),
	});
	expect((await restarted.call(`${restarted.url}/_boot/lock`)).status).toBe(200);
	expect(await env.sql("SELECT id,holder_family,cutover_in_flight,reset_pin FROM edit_lock")).toEqual(held);
	expect(
		(
			await fetch(`${restarted.url}/_boot/revert`, {
				...post,
				headers: { "content-type": "application/json", cookie: restarted.session.cookie, origin: "https://wrong.test" },
			})
		).status,
	).toBe(403);
	expect((await fetch(`${restarted.url}/_boot/revert`, post)).status).toBe(401);
	expect(
		(await restarted.call(`${restarted.url}/_boot/fs/app/nope.ts?reload=0`, { method: "PUT", body: "unsafe" })).status,
	).toBe(503);
	expect(await env.sql("SELECT closed FROM child_attempts WHERE id='late-owner'")).toEqual([{ closed: 0 }]);
	await writeFile(join(env.root, "observe-retry"), "observe");
	const disconnected = new AbortController();
	const abandoned = restarted.call(`${restarted.url}/_boot/lock`, { ...post, signal: disconnected.signal }).then(
		() => "response",
		() => "disconnected",
	);
	await expect
		.poll(() => readFile(join(env.root, "retry-entered"), "utf8").catch(() => ""), { timeout: 5000 })
		.toBe("entered");
	disconnected.abort();
	expect(await abandoned).toBe("disconnected");
	await writeFile(receipt, "late-owner");
	const locks = await Promise.all([
		restarted.call(`${restarted.url}/_boot/lock`, post),
		restarted.call(`${restarted.url}/_boot/lock`, post),
	]);
	expect(locks.map((response) => response.status)).toEqual([423, 423]);
	await expect.poll(async () => (await restarted.call(restarted.url)).status, { timeout: 10000 }).toBe(200);
	const reverted = await restarted.call(`${restarted.url}/_boot/revert`, {
		...post,
		headers: { "content-type": "application/json", "idempotency-key": "repair-once" },
	});
	expect(await reverted.json()).toMatchObject({ status: "live" });
	expect(reverted.status).toBe(200);
	expect(await readFile(join(env.root, "data/app/child.ts"), "utf8")).toBe(original);
	expect(await readFile(join(env.root, "data/pages/index.md"), "utf8")).toBe("preserved page");
	expect(await env.sql("SELECT body FROM preserved_message", "comms.db")).toEqual([{ body: "acknowledged" }]);
	expect(await env.sql("SELECT CAST(content AS TEXT) AS content FROM staging")).toEqual([{ content: "staged" }]);
	expect(await env.sql("SELECT closed FROM child_attempts WHERE id='late-owner'")).toEqual([{ closed: 1 }]);
	expect(await env.sql("SELECT COUNT(*) AS count FROM generations")).toEqual([{ count: 3 }]);
	expect(await env.sql("SELECT COUNT(*) AS count FROM sessions")).toEqual([{ count: 2 }]);
}, 40000);

it("returns a typed conflict and preserves competing recovery journals on human repair", async (test) => {
	const env = await fixture(test);
	const first = await env.start();
	await first.stop();
	await env.sql("INSERT INTO cutover VALUES(1,1,NULL,NULL,'held','family','working',NULL)");
	await env.sql("INSERT INTO source_batches(id,lock_id,agent,at,state) VALUES('competing',NULL,'boot',0,'publishing')");
	const journals = await env.sql("SELECT * FROM cutover");
	const restarted = await env.start(false);
	await expect.poll(restarted.status, { timeout: 5000 }).toMatchObject({
		child: { state: "failed" },
		source_recovery_error: expect.stringContaining("recovery_intents_conflict"),
	});
	const refused = await restarted.call(`${restarted.url}/_boot/revert`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	expect(refused.status).toBe(503);
	expect(await refused.json()).toMatchObject({ error: { code: "publication_pending" } });
	expect(await env.sql("SELECT * FROM cutover")).toEqual(journals);
	expect(await env.sql("SELECT state FROM source_batches WHERE id='competing'")).toEqual([{ state: "publishing" }]);
	expect(await readFile(join(env.root, "data/pages/index.md"), "utf8")).toBe("preserved page");
	expect((await restarted.call(`${restarted.url}/_boot/recovery`)).status).toBe(200);
});

it("closes a restore-activated child before retrying a later startup failure without replaying the restore", async (test) => {
	const env = await fixture(test);
	const first = await env.start();
	await env.sql("CREATE TABLE retained(value TEXT)", "comms.db");
	await env.sql("INSERT INTO retained VALUES('before restore')", "comms.db");
	await first.stop();
	await mkdir(join(env.root, "data/backups"), { recursive: true });
	const backup = join(env.root, "data/backups/safety.db");
	await env.sql(`VACUUM INTO '${backup}'`, "comms.db");
	await env.sql(
		`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through,generation) VALUES('safety','${backup}','pre-restore',0,0,0,1)`,
	);
	await env.sql(
		"INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,safety_backup,generation,prior_generation,restored_to_seq) VALUES('restore','hash','session','safety','rollback','safety',1,1,0)",
	);
	// Restore activates the selected generation before source receipt reconciliation encounters corrupt metadata.
	await env.sql("INSERT INTO settings(key,value) VALUES('source-revert-result:broken','invalid-json')");
	const restarted = await env.start(false);
	await expect
		.poll(restarted.status, { timeout: 10000 })
		.toMatchObject({ child: { state: "failed", pid: expect.any(Number) }, source_recovery_error: expect.any(String) });
	expect(await env.sql("SELECT phase FROM db_restore_requests")).toEqual([{ phase: "failed" }]);
	expect(await env.sql("SELECT COUNT(*) AS count FROM child_attempts WHERE closed=0")).toEqual([{ count: 1 }]);
	await env.sql("INSERT INTO retained VALUES('after restore')", "comms.db");
	await env.sql("DELETE FROM settings WHERE key='source-revert-result:broken'");
	const repaired = await restarted.call(`${restarted.url}/_boot/lock`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	expect(repaired.status).toBe(200);
	await expect
		.poll(restarted.status, { timeout: 10000 })
		.toMatchObject({ child: { state: "live" }, source_recovery_error: null });
	expect(await env.sql("SELECT value FROM retained ORDER BY rowid", "comms.db")).toEqual([
		{ value: "before restore" },
		{ value: "after restore" },
	]);
	expect(await env.sql("SELECT COUNT(*) AS count FROM child_attempts WHERE closed=1")).toEqual([{ count: 2 }]);
	expect(await env.sql("SELECT COUNT(*) AS count FROM child_attempts WHERE closed=0")).toEqual([{ count: 1 }]);
	expect(await env.sql("SELECT COUNT(*) AS count FROM generations")).toEqual([{ count: 1 }]);
}, 30000);

it("returns retriable anonymous page refusal during recovery without relaxing explicit credentials or grants", async (test) => {
	const env = await fixture(test);
	const first = await env.start();
	await mkdir(join(env.root, "data/pages/public"));
	await writeFile(join(env.root, "data/pages/public/index.md"), "public content");
	await env.sql("INSERT INTO public_paths(path) VALUES('public')");
	expect((await fetch(`${first.url}/p/public/index.md`)).status).toBe(200);
	expect((await fetch(`${first.url}/p/index.md`)).status).toBe(401);
	await first.stop();
	const receipt = join(env.root, "data/attempts/late-owner.closed");
	await env.sql(
		`INSERT INTO child_attempts(id,generation,receipt,opened,closed) VALUES('late-owner',1,'${receipt}',1,0)`,
	);
	await writeFile(join(env.root, "observe-retry"), "observe");
	const restarted = await env.start(false);
	await expect
		.poll(() => readFile(join(env.root, "retry-entered"), "utf8").catch(() => ""), { timeout: 5000 })
		.toBe("entered");
	expect(await restarted.status()).toMatchObject({ child: { state: "starting" } });
	const unavailable = async () => {
		for (const path of ["/p/public/index.md", "/p/index.md", "/p/missing.md"]) {
			const response = await fetch(`${restarted.url}${path}`);
			expect(response.status).toBe(503);
			const body: unknown = await response.json();
			expect(body).toEqual({
				error: { code: "boot_unavailable", message: expect.any(String), hint: expect.any(String), retriable: true },
			});
		}
		expect((await fetch(`${restarted.url}/p/public/index.md`, { method: "HEAD" })).status).toBe(503);
		for (const headers of [{ authorization: "Bearer invalid" }, { cookie: "__Host-comms_session=invalid" }])
			expect((await fetch(`${restarted.url}/p/public/index.md`, { headers })).status).toBe(401);
		expect((await fetch(`${restarted.url}/p/public/index.md`, { method: "POST" })).status).toBe(401);
		expect((await fetch(`${restarted.url}/_boot/status`)).status).toBe(401);
	};
	await unavailable();
	await expect.poll(restarted.status, { timeout: 12000 }).toMatchObject({ child: { state: "failed" } });
	await unavailable();
	await writeFile(receipt, "late-owner");
	expect(
		(
			await restarted.call(`${restarted.url}/_boot/lock`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			})
		).status,
	).toBe(200);
	await expect
		.poll(async () => (await fetch(`${restarted.url}/p/public/index.md`)).status, { timeout: 10000 })
		.toBe(200);
	expect((await fetch(`${restarted.url}/p/index.md`)).status).toBe(401);
	expect(
		(await fetch(`${restarted.url}/p/public/index.md`, { headers: { authorization: "Bearer invalid" } })).status,
	).toBe(401);
}, 30000);

it("commits human lock metadata while recovery remains broken and refuses conflicting journal cleanup", async (test) => {
	const env = await fixture(test);
	const first = await env.start();
	await first.stop();
	await env.sql("INSERT INTO settings(key,value) VALUES('source-revert-result:broken','invalid-json-private-detail')");
	const restarted = await env.start(false);
	await expect.poll(restarted.status, { timeout: 10000 }).toMatchObject({ child: { state: "failed" } });
	const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
	const acquired = await restarted.call(`${restarted.url}/_boot/lock`, post);
	expect(acquired.status).toBe(503);
	const value: unknown = await acquired.json();
	expect(value).toMatchObject({
		lock_committed: true,
		lock: { holder_family: restarted.session.id },
		recovery: { status: "failed", error: { code: "recovery_failed" } },
	});
	expect(JSON.stringify(value)).not.toContain("invalid-json-private-detail");
	expect(await env.sql("SELECT COUNT(*) AS n FROM edit_lock")).toEqual([{ n: 1 }]);
	expect(
		(await restarted.call(`${restarted.url}/_boot/fs/app/nope.ts?reload=0`, { method: "PUT", body: "unsafe" })).status,
	).toBe(503);
	const released = await restarted.call(`${restarted.url}/_boot/lock`, { method: "DELETE" });
	expect(released.status).toBe(503);
	expect(await released.json()).toMatchObject({ lock: null, lock_committed: true, recovery: { status: "failed" } });
	expect(await env.sql("SELECT * FROM edit_lock")).toEqual([]);
	await env.sql("INSERT INTO cutover VALUES(1,1,NULL,NULL,'missing-lock','family','working',NULL)");
	const journal = await env.sql("SELECT * FROM cutover");
	const refused = await restarted.call(`${restarted.url}/_boot/lock`, post);
	expect(refused.status).toBe(409);
	expect(await refused.json()).toMatchObject({ error: { code: "lock_recovery_conflict" } });
	expect(await env.sql("SELECT * FROM cutover")).toEqual(journal);
	expect(await env.sql("SELECT * FROM edit_lock")).toEqual([]);
}, 30000);

it("exposes adoption status only after authentication and surfaces preidentity upgrade refusal without migration", async (test) => {
	const env = await fixture(test);
	const first = await env.start();
	expect(await first.status()).toMatchObject({
		store_identity: {
			app_store_id: expect.any(String),
			adoption_phase: "ready",
			selected_filename: join(env.root, "data/comms.db"),
			recorded_filename: join(env.root, "data/comms.db"),
		},
	});
	expect((await fetch(`${first.url}/_boot/status`)).status).toBe(401);
	await first.stop();
	await env.sql("DELETE FROM settings WHERE key IN ('app_store_adoption','app_store_id')");
	await env.sql("DROP TABLE boot_migrations");
	await env.sql("ALTER TABLE backups DROP COLUMN legacy_store_id");
	await env.sql("PRAGMA user_version=16");
	await env.sql("INSERT INTO cutover VALUES(1,1,NULL,NULL,'held','family','working',NULL)");
	const journal = await env.sql("SELECT * FROM cutover");
	const restarted = await env.start(false);
	for (const path of ["/setup", "/auth/login", "/_boot/status"]) {
		await expect.poll(async () => (await fetch(`${restarted.url}${path}`)).status).toBe(409);
		const response = await fetch(`${restarted.url}${path}`);
		const body: unknown = await response.json();
		expect(body).toMatchObject({ error: { code: "boot_identity_upgrade_pending", retriable: false } });
		expect(JSON.stringify(body)).not.toContain(env.root);
	}
	expect((await fetch(`${restarted.url}/_kernel/control`)).status).toBe(403);
	expect((await fetch(`${restarted.url}/health`)).status).toBe(200);
	expect(await env.sql("PRAGMA user_version")).toEqual([{ user_version: 16 }]);
	expect(await env.sql("SELECT * FROM cutover")).toEqual(journal);
});
