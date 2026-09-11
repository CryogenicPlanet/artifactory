import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { storageFixture } from "./fixtures/storage-maintenance.ts";

const admission = Schema.Struct({
	traffic: Schema.Struct({ frozen: Schema.Boolean }),
	fixture_requests: Schema.Struct({ frozen: Schema.Boolean }),
});

async function exposeRequestGate(root: string) {
	// Observe the real gate in the disposable boot process, without a production test endpoint.
	const filename = join(root, "packages/boot/src/proxy.ts");
	const source = await readFile(filename, "utf8");
	const needle = "traffic: yield* child.traffic.state,";
	expect(source.split(needle)).toHaveLength(2);
	await writeFile(
		filename,
		source.replace(needle, `${needle}\nfixture_requests: yield* child.traffic.requests.state,`),
	);
}

async function gates(url: string, cookie: string) {
	return Schema.decodeUnknownSync(admission)(
		await (await fetch(`${url}/_boot/status`, { headers: { cookie } })).json(),
	);
}

it.for(["selection", "lock-release"] as const)(
	"releases both gates after a restore %s failure without serving an unfinalized owner",
	{ timeout: 45000 },
	async (boundary, test) => {
		const fixture = await storageFixture(test);
		await exposeRequestGate(fixture.root);
		const filename = join(fixture.root, "packages/boot/src/database-restore.ts");
		const source = await readFile(filename, "utf8");
		const armed = join(fixture.root, "restore-failure");
		const needle =
			boundary === "selection"
				? "yield* sql`UPDATE db_restore_requests SET phase='restoring' WHERE proof_id=${record.proof_id}`;"
				: "if (!record.lock_id || !record.lock_family) return;";
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			filename,
			source.replace(
				needle,
				`${needle}
			if (yield* fs.exists(${JSON.stringify(armed)}))
				return yield* new ChildError({ code: "restore_recovery_required" });`,
			),
		);
		const app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		expect((await app.post("/api/messages", { topic: "restore", body: "saved" }, cookie)).status).toBe(200);
		await fixture.force("hourly");
		await expect.poll(async () => (await fixture.backups()).length, { timeout: 10000 }).toBe(1);
		await fixture.cycle();
		const [saved] = await fixture.backups();
		if (!saved) throw Error("Missing backup");
		expect((await app.post("/api/messages", { topic: "restore", body: "fresh" }, cookie)).status).toBe(200);
		const proof = await app.signedAssertion("db.restore", { backup: saved.id }, cookie);
		await writeFile(armed, "armed");
		const response = await fetch(`${app.url}/_boot/db/restore`, {
			method: "POST",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json", "X-Comms-Assertion": proof },
			body: JSON.stringify({ backup: saved.id }),
		});
		expect({ status: response.status, body: await response.json() }).toMatchObject({
			status: 409,
			body: { error: { code: "restore_recovery_required", retriable: false } },
		});
		expect(await gates(app.url, cookie)).toEqual({ traffic: { frozen: false }, fixture_requests: { frozen: false } });
		expect((await fetch(`${app.url}/api/messages?since=0`, { headers: { cookie } })).status).toBe(503);
		expect((await app.post("/api/messages", { topic: "restore", body: "unsafe" }, cookie)).status).toBe(503);
		expect((await fetch(`${app.url}/auth/login`)).status).toBe(200);
		expect(
			await fixture.sql("SELECT COUNT(*) count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
		).toEqual([{ count: 0 }]);
		expect(await fixture.sql("SELECT body FROM messages ORDER BY seq")).toEqual(
			boundary === "selection" ? [{ body: "saved" }, { body: "fresh" }] : [{ body: "saved" }],
		);
		await rm(armed);
		await app.stop();
		const restarted = await fixture.launch();
		await restarted.ready(cookie);
		expect(await fixture.sql("SELECT body FROM messages ORDER BY seq")).toEqual([{ body: "saved" }]);
		expect((await restarted.post("/api/messages", { topic: "restore", body: "after recovery" }, cookie)).status).toBe(
			200,
		);
	},
);

it("resumes the live owner after a harmless topic move refusal", async (test) => {
	const fixture = await storageFixture(test);
	await exposeRequestGate(fixture.root);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const response = await app.post("/api/topics/missing/move", { to: "destination" }, cookie);
	expect(response.status).toBe(404);
	expect(await gates(app.url, cookie)).toEqual({ traffic: { frozen: false }, fixture_requests: { frozen: false } });
	expect((await fetch(`${app.url}/api/messages?since=0`, { headers: { cookie } })).status).toBe(200);
	expect((await app.post("/api/messages", { topic: "source", body: "after refusal" }, cookie)).status).toBe(200);
}, 30000);
