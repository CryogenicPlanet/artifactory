import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { storageFixture } from "./fixtures/storage-maintenance.ts";

for (const scenario of [
	"missing",
	"foreign",
	"foreign-target",
	"pending",
	"failed-candidate",
	"failed-prepare",
] as const)
	it(`offline restore preserves authority and previous state for ${scenario}`, async (test) => {
		const fixture = await storageFixture(test);
		const app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		expect((await app.post("/api/messages", { topic: "offline", body: "retained" }, cookie)).status).toBe(200);
		await fixture.force("hourly");
		await expect.poll(async () => (await fixture.backups()).length).toBe(1);
		await fixture.cycle();
		const [saved] = await fixture.backups();
		if (!saved) throw Error("Missing fixture backup");
		const [identity] = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ value: Schema.String })))(
			await fixture.sql("SELECT value FROM settings WHERE key='app_store_id'", "boot.db"),
		);
		if (!identity) throw new Error("Missing adopted store identity");
		const foreignId = scenario === "foreign" ? "aabbccdd-1234-4567-89ab-0123456789ab" : "foreign-board";
		await app.stop();
		if (scenario === "missing") {
			for (const suffix of ["", "-wal", "-shm", "-journal"])
				await rm(join(fixture.root, `comms.db${suffix}`), { force: true });
		} else {
			await fixture.sql(`UPDATE store_identity SET store_id='${foreignId}'`);
		}
		if (scenario === "foreign-target")
			await fixture.sql("UPDATE store_identity SET store_id='other-board'", `backups/${saved.id}.db`);
		if (scenario === "pending") {
			await fixture.sql(
				"UPDATE seq SET next=next+1,pending_id='unresolved',pending_attempt='old',pending_from=next,pending_to=next",
				"boot.db",
			);
		}
		const previous = scenario === "missing" ? null : await readFile(join(fixture.root, "comms.db"));
		if (scenario === "failed-candidate" || scenario === "failed-prepare") {
			const coordinator = join(fixture.root, "packages/boot/src/database-restore.ts");
			const source = await readFile(coordinator, "utf8");
			const needle =
				scenario === "failed-prepare"
					? "const preserved = yield* beforeImage.prepare(offline.storeId);"
					: 'yield* candidate.process.health.pipe(Effect.timeout("5 seconds"));';
			expect(source.split(needle)).toHaveLength(2);
			await writeFile(coordinator, source.replace(needle, 'yield* new ChildError({ code: "health_failed" });'));
		}
		const resumed = await fixture.launch();
		await expect
			.poll(async () => (await fixture.status(resumed.url, cookie)).child.state, { timeout: 15000 })
			.toBe("failed");
		expect((await fetch(`${resumed.url}/_boot/status`)).status).toBe(401);
		if (scenario !== "missing")
			expect(await (await fetch(`${resumed.url}/_boot/status`, { headers: { cookie } })).json()).toMatchObject({
				child: {
					identity_error: {
						expected_store_id: identity.value,
						observed_store_id: scenario === "foreign" ? foreignId : null,
					},
				},
			});
		const proof = await resumed.signedAssertion("db.restore", { backup: saved.id }, cookie);
		const request = () =>
			fetch(`${resumed.url}/_boot/db/restore`, {
				method: "POST",
				headers: {
					cookie,
					origin: "https://comms.test",
					"content-type": "application/json",
					"X-Chirp-Assertion": proof,
				},
				body: JSON.stringify({ backup: saved.id }),
			});
		const response = await request();
		const result: unknown = await response.json();
		if (scenario === "missing" || scenario === "foreign") {
			expect(result).toMatchObject({ status: "restored", safety_backup: null });
			expect(response.status).toBe(200);
			await resumed.ready(cookie);
			const healthy = Schema.decodeUnknownSync(
				Schema.Struct({
					child: Schema.Struct({ identity_error: Schema.optionalKey(Schema.NullOr(Schema.Unknown)) }),
				}),
			)(await (await fetch(`${resumed.url}/_boot/status`, { headers: { cookie } })).json());
			expect(healthy.child.identity_error ?? null).toBeNull();
			expect(await fixture.sql("SELECT body FROM messages WHERE topic='offline'")).toEqual([{ body: "retained" }]);
			expect((await resumed.post("/api/messages", { topic: "offline", body: "after repair" }, cookie)).status).toBe(
				200,
			);
			expect(await (await request()).json()).toEqual(result);
		} else {
			if (scenario === "failed-prepare")
				expect(result).toMatchObject({ status: "failed", error: "restore_preparation_failed" });
			else expect(response.status).toBeGreaterThanOrEqual(400);
			expect(await readFile(join(fixture.root, "comms.db"))).toEqual(previous);
			expect((await fetch(`${resumed.url}/api/messages?since=0`, { headers: { cookie } })).status).toBe(503);
			await resumed.stop();
			const restarted = await fixture.launch();
			await expect
				.poll(async () => (await fixture.status(restarted.url, cookie)).child.state, { timeout: 15000 })
				.toBe("failed");
			expect(await readFile(join(fixture.root, "comms.db"))).toEqual(previous);
			if (scenario === "pending")
				expect(await fixture.sql("SELECT pending_id FROM seq", "boot.db")).toEqual([{ pending_id: "unresolved" }]);
		}
	}, 45000);
