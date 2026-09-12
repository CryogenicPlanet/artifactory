import { sourcePut } from "./fixtures/source-put.ts";
import { basename, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { storageFixture } from "./fixtures/storage-maintenance.ts";

const restored = Schema.Struct({
	status: Schema.Literal("restored"),
	backup: Schema.String,
	safety_backup: Schema.String,
	generation: Schema.Int,
	restored_to_seq: Schema.Int,
	event_seq: Schema.Int,
});

const setPublic = async (url: string, cookie: string, topic: string, value: boolean) => {
	const response = await fetch(`${url}/api/topics/${topic}`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
		body: JSON.stringify({ meta: { public: value } }),
	});
	expect(response.status).toBe(200);
};
const pageGrants = async (url: string, publicTopic: string, privateTopic: string) => {
	const response = await fetch(`${url}/p/${publicTopic}/index.md?raw=1`);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe(`# ${publicTopic}`);
	expect((await fetch(`${url}/p/${privateTopic}/index.md`)).status).toBe(401);
};

it("restores only the selected app data, keeps a fresh safety copy and staging, and replays the exact result without undoing newer writes across restart", async (test) => {
	const fixture = await storageFixture(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	for (const topic of ["public-old", "public-new"]) {
		await mkdir(join(fixture.root, "pages", topic), { recursive: true });
		await writeFile(join(fixture.root, "pages", topic, "index.md"), `# ${topic}`);
	}
	await setPublic(app.url, cookie, "public-old", true);
	await setPublic(app.url, cookie, "public-new", false);
	await pageGrants(app.url, "public-old", "public-new");
	const create = (body: string) => app.post("/api/messages", { topic: "restore", body }, cookie);
	expect((await create("A before backup")).status).toBe(200);
	await fixture.force("hourly");
	await expect.poll(async () => (await fixture.backups()).length, { timeout: 10000 }).toBe(1);
	await fixture.cycle();
	const [saved] = await fixture.backups();
	if (!saved) throw Error("Missing selected backup");
	await setPublic(app.url, cookie, "public-old", false);
	await setPublic(app.url, cookie, "public-new", true);
	await pageGrants(app.url, "public-new", "public-old");
	const savedBytes = await readFile(saved.path);
	expect((await create("B before restore")).status).toBe(200);
	const beforeMessages = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
	const beforeEpoch = await fixture.sql("SELECT epoch FROM kernel_writer");
	const beforeEvents = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ seq: Schema.Int })))(
		await fixture.sql("SELECT MAX(seq) seq FROM events", "boot.db"),
	);
	const beforeOwner = (await fixture.status(app.url, cookie)).child;
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const stagedBody = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
	expect(
		(
			await sourcePut(`${app.url}/api/fs/app/server.ts?reload=0`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: stagedBody + "\n// pending human edit\n",
			})
		).status,
	).toBe(200);
	const beforeStaging = await fixture.sql("SELECT * FROM staging", "boot.db");
	const beforeLock = await fixture.sql(
		"SELECT id,holder_family,agent,cutover_in_flight,pending_release FROM edit_lock",
		"boot.db",
	);
	const refused = (headers: Record<string, string>, body: unknown = { backup: saved.id }) =>
		fetch(`${app.url}/_boot/db/restore`, {
			method: "POST",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	expect((await refused({})).status).toBe(401);
	expect((await refused({ origin: "https://other.test" })).status).toBe(403);
	expect((await refused({ authorization: "Bearer invalid" })).status).toBe(401);
	expect((await refused({}, { backup: saved.id, id: saved.id })).status).toBe(400);
	const key = "restore-first-result";
	const proof = await app.signedAssertion("db.restore", { backup: saved.id, idempotency_key: key }, cookie);
	const request = (url: string) =>
		fetch(`${url}/_boot/db/restore`, {
			method: "POST",
			headers: {
				cookie,
				origin: "https://comms.test",
				"content-type": "application/json",
				"X-Comms-Assertion": proof,
				"Idempotency-Key": key,
			},
			body: JSON.stringify({ id: saved.id }),
		});
	const response = await request(app.url);
	expect(response.status).toBe(200);
	const result = Schema.decodeUnknownSync(restored)(await response.json());
	expect(result.backup).toBe(saved.id);
	expect(result.restored_to_seq).toBe(saved.published_through);
	expect(result.generation).toBe(beforeOwner.generation);
	expect(result.event_seq).toBeGreaterThan(beforeEvents[0]?.seq ?? 0);
	await app.ready(cookie);
	await pageGrants(app.url, "public-old", "public-new");
	expect(await fixture.sql("SELECT body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual([
		{ body: "A before backup" },
	]);
	expect(
		await (await fetch(`${app.url}/api/messages?topic=restore&since=0&wait=0`, { headers: { cookie } })).json(),
	).toMatchObject({
		items: [{ body: "A before backup" }],
	});
	expect(await fixture.sql("SELECT epoch FROM kernel_writer")).not.toEqual(beforeEpoch);

	expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual(beforeStaging);
	expect(
		await fixture.sql("SELECT id,holder_family,agent,cutover_in_flight,pending_release FROM edit_lock", "boot.db"),
	).toEqual(beforeLock);
	const safety = (await fixture.backups()).find((row) => row.id === result.safety_backup);
	if (!safety) throw Error("Missing fresh restore safety backup");
	expect(
		await fixture.sql(
			"SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq",
			join("backups", basename(safety.path)),
		),
	).toEqual(beforeMessages);
	expect(await readFile(saved.path)).toEqual(savedBytes);
	expect((await create("C after successful restore")).status).toBe(200);
	await setPublic(app.url, cookie, "public-old", false);
	await setPublic(app.url, cookie, "public-new", true);
	const fresh = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
	expect(
		await fixture.sql(
			`SELECT COUNT(*) count FROM messages WHERE body='C after successful restore' AND seq>${result.event_seq}`,
		),
	).toEqual([{ count: 1 }]);
	expect(await (await request(app.url)).json()).toEqual(result);
	await pageGrants(app.url, "public-new", "public-old");
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(fresh);
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(await (await request(resumed.url)).json()).toEqual(result);
	await pageGrants(resumed.url, "public-new", "public-old");
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(fresh);
	expect(
		await fixture.sql("SELECT seq FROM events WHERE json_extract(event,'$.type')='db.restored'", "boot.db"),
	).toEqual([{ seq: result.event_seq }]);
	expect(await fixture.sql("SELECT COUNT(*) count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db")).toEqual(
		[{ count: 1 }],
	);
}, 45000);

it("rolls a failed candidate health check back to the fresh safety copy and records failure before permitting later writes", async (test) => {
	const fixture = await storageFixture(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	for (const topic of ["public-old", "public-new"]) {
		await mkdir(join(fixture.root, "pages", topic), { recursive: true });
		await writeFile(join(fixture.root, "pages", topic, "index.md"), `# ${topic}`);
	}
	await setPublic(app.url, cookie, "public-old", true);
	await setPublic(app.url, cookie, "public-new", false);
	await pageGrants(app.url, "public-old", "public-new");
	expect((await app.post("/api/messages", { topic: "restore", body: "A before backup" }, cookie)).status).toBe(200);
	await fixture.force("hourly");
	await expect.poll(async () => (await fixture.backups()).length, { timeout: 10000 }).toBe(1);
	await fixture.cycle();
	const [saved] = await fixture.backups();
	if (!saved) throw Error("Missing selected backup");
	await setPublic(app.url, cookie, "public-old", false);
	await setPublic(app.url, cookie, "public-new", true);
	await pageGrants(app.url, "public-new", "public-old");
	expect((await app.post("/api/messages", { topic: "restore", body: "B before restore" }, cookie)).status).toBe(200);
	const messages = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
	const epoch = await fixture.sql("SELECT epoch FROM kernel_writer");
	const generation = (await fixture.status(app.url, cookie)).child.generation;
	if (generation === null) throw Error("Missing live generation");
	const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ snapshot_dir: Schema.String })))(
		await fixture.sql(`SELECT snapshot_dir FROM generations WHERE n=${generation}`, "boot.db"),
	);
	const snapshot = rows[0]?.snapshot_dir;
	if (!snapshot) throw Error("Missing retained snapshot");
	// Only this disposable retained generation gets a health failure for the old
	// store. The fresh safety copy contains B and passes the actual health probe.
	const healthPath = join(snapshot, "kernel/health.ts");
	const health = await readFile(healthPath, "utf8");
	const needle = "const sql = yield* SqlClient.SqlClient;";
	expect(health.split(needle)).toHaveLength(2);
	await writeFile(
		healthPath,
		health.replace(
			needle,
			`${needle}
		if ((yield* sql\`SELECT id FROM messages WHERE body='B before restore'\`).length === 0)
			return yield* new KernelError({ code: "restore_fixture_health_failure" });`,
		),
	);
	const proof = await app.signedAssertion("db.restore", { backup: saved.id }, cookie);
	const request = () =>
		fetch(`${app.url}/_boot/db/restore`, {
			method: "POST",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json", "X-Comms-Assertion": proof },
			body: JSON.stringify({ backup: saved.id }),
		});
	const response = await request();
	const result: unknown = await response.json();
	expect(result).toMatchObject({ status: "failed", backup: saved.id });
	await app.ready(cookie);
	await pageGrants(app.url, "public-new", "public-old");
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(messages);
	expect(await fixture.sql("SELECT epoch FROM kernel_writer")).not.toEqual(epoch);
	expect(await fixture.sql("SELECT phase FROM db_restore_requests", "boot.db")).toEqual([{ phase: "failed" }]);
	expect(
		await fixture.sql("SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='db.restored'", "boot.db"),
	).toEqual([{ count: 0 }]);
	expect((await app.post("/api/messages", { topic: "restore", body: "C after failed restore" }, cookie)).status).toBe(
		200,
	);
	const fresh = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
	expect(await (await request()).json()).toEqual(result);
	await pageGrants(app.url, "public-new", "public-old");
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	await pageGrants(resumed.url, "public-new", "public-old");
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(fresh);
	expect(await fixture.sql("SELECT COUNT(*) count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db")).toEqual(
		[{ count: 1 }],
	);
}, 45000);

it("refuses replacement and stays unavailable across restart when the prior owner's closure receipt cannot be proven", async (test) => {
	const fixture = await storageFixture(test);
	const coordinator = join(fixture.root, "packages/boot/src/database-restore.ts");
	const source = await readFile(coordinator, "utf8");
	const needle = "yield* stop(prior);";
	expect(source.split(needle)).toHaveLength(2);
	await writeFile(
		coordinator,
		source.replace(
			needle,
			`yield* prior.process.stop;
		yield* fs.writeFileString(prior.receipt, "deliberately invalid test closure receipt");
		${needle}`,
		),
	);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "restore", body: "A before backup" }, cookie)).status).toBe(200);
	await fixture.force("hourly");
	await expect.poll(async () => (await fixture.backups()).length, { timeout: 10000 }).toBe(1);
	await fixture.cycle();
	const [saved] = await fixture.backups();
	if (!saved) throw Error("Missing selected backup");
	expect((await app.post("/api/messages", { topic: "restore", body: "B before restore" }, cookie)).status).toBe(200);
	const messages = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
	const proof = await app.signedAssertion("db.restore", { backup: saved.id }, cookie);
	const response = await fetch(`${app.url}/_boot/db/restore`, {
		method: "POST",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json", "X-Comms-Assertion": proof },
		body: JSON.stringify({ backup: saved.id }),
	});
	expect(response.status).toBeGreaterThanOrEqual(400);
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(messages);
	expect(
		await fixture.sql("SELECT phase,safety_backup IS NOT NULL has_safety FROM db_restore_requests", "boot.db"),
	).toEqual([{ phase: "authorized", has_safety: 1 }]);
	expect((await fetch(`${app.url}/api/messages?since=0`, { headers: { cookie } })).status).toBe(503);
	expect((await fetch(`${app.url}/auth/login`)).status).toBe(200);
	expect(await fixture.sql("SELECT opened,closed FROM child_attempts", "boot.db")).toEqual([{ opened: 1, closed: 0 }]);
	await app.stop();
	const resumed = await fixture.launch();
	await expect
		.poll(async () => (await fixture.status(resumed.url, cookie)).child.state, { timeout: 10000 })
		.toBe("failed");
	expect((await fetch(`${resumed.url}/api/messages?since=0`, { headers: { cookie } })).status).toBe(503);
	expect((await fetch(`${resumed.url}/auth/login`)).status).toBe(200);
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(messages);
	expect(await fixture.sql("SELECT opened,closed FROM child_attempts", "boot.db")).toEqual([{ opened: 1, closed: 0 }]);
	expect(
		await fixture.sql("SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='db.restored'", "boot.db"),
	).toEqual([{ count: 0 }]);
}, 30000);

it("closes the candidate and rolls back to fresh data when the restore HTTP request is aborted during health", async (test) => {
	const fixture = await storageFixture(test);
	const coordinator = join(fixture.root, "packages/boot/src/database-restore.ts");
	const source = await readFile(coordinator, "utf8");
	const marker = join(fixture.root, "restore-awaiting-health");
	const needle = 'yield* candidate.process.health.pipe(Effect.timeout("5 seconds"));';
	expect(source.split(needle)).toHaveLength(2);
	await writeFile(
		coordinator,
		source.replace(
			needle,
			`yield* fs.writeFileString(${JSON.stringify(marker)}, candidate.id);
		yield* Effect.never;
		${needle}`,
		),
	);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "restore", body: "A before backup" }, cookie)).status).toBe(200);
	await fixture.force("hourly");
	await expect.poll(async () => (await fixture.backups()).length, { timeout: 10000 }).toBe(1);
	await fixture.cycle();
	const [saved] = await fixture.backups();
	if (!saved) throw Error("Missing selected backup");
	expect((await app.post("/api/messages", { topic: "restore", body: "B before restore" }, cookie)).status).toBe(200);
	const messages = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
	const proof = await app.signedAssertion("db.restore", { backup: saved.id }, cookie);
	const controller = new AbortController();
	test.onTestFinished(() => controller.abort());
	const pending = fetch(`${app.url}/_boot/db/restore`, {
		method: "POST",
		signal: controller.signal,
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json", "X-Comms-Assertion": proof },
		body: JSON.stringify({ backup: saved.id }),
	}).catch(() => null);
	await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 10000 }).not.toBe("");
	const candidate = await readFile(marker, "utf8");
	expect(await fixture.sql("SELECT phase FROM db_restore_requests", "boot.db")).toEqual([{ phase: "working" }]);
	controller.abort();
	expect(await pending).toBeNull();
	await expect
		.poll(() => fixture.sql("SELECT phase FROM db_restore_requests", "boot.db"), { timeout: 10000 })
		.toEqual([{ phase: "failed" }]);
	await app.ready(cookie);
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(messages);
	expect(await readFile(join(fixture.root, "attempts", `${candidate}.closed`), "utf8")).toBe(candidate);
	expect(await fixture.sql(`SELECT opened,closed FROM child_attempts WHERE id='${candidate}'`, "boot.db")).toEqual([
		{ opened: 1, closed: 1 },
	]);
	await expect
		.poll(() => fixture.sql("SELECT COUNT(*) count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"), {
			timeout: 10000,
		})
		.toEqual([{ count: 1 }]);
	await expect.poll(async () => (await fixture.status(app.url, cookie)).traffic.frozen, { timeout: 10000 }).toBe(false);
	expect(
		(await app.post("/api/messages", { topic: "restore", body: "C after cancelled restore" }, cookie)).status,
	).toBe(200);
	expect(
		await fixture.sql("SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='db.restored'", "boot.db"),
	).toEqual([{ count: 0 }]);
}, 30000);
