import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { storageFixture } from "./fixtures/storage-maintenance.ts";

it.for(["restoring", "working", "restored", "legacy-restoring"] as const)(
	"recovers the %s store selection after SIGKILL and never reapplies it over later acknowledged writes",
	{ timeout: 45000 },
	async (checkpoint, test) => {
		const phase = checkpoint === "legacy-restoring" ? "restoring" : checkpoint;
		const fixture = await storageFixture(test);
		const coordinator = join(fixture.root, "packages/boot/src/database-restore.ts");
		const source = await readFile(coordinator, "utf8");
		const armed = join(fixture.root, "restore-crash-armed");
		const reached = join(fixture.root, "restore-crash-reached");
		const needle =
			phase === "restoring"
				? "const restored = yield* backup.restoreInto(target);"
				: phase === "working"
					? 'yield* candidate.process.health.pipe(Effect.timeout("5 seconds"));'
					: 'yield* supervisor.activate(candidate, "live").pipe(Effect.provideContext(context));';
		// Faults exist only in a disposable copy. A durable marker lets the test
		// kill boot at an exact authority boundary, without production fault flags.
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			coordinator,
			source.replace(
				needle,
				`if (yield* fs.exists(${JSON.stringify(armed)})) {
				yield* fs.writeFileString(${JSON.stringify(reached)}, ${JSON.stringify(phase)});
				yield* Effect.never;
			}
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
		const proof = await app.signedAssertion("db.restore", { backup: saved.id }, cookie);
		const request = (url: string) =>
			fetch(`${url}/_boot/db/restore`, {
				method: "POST",
				headers: {
					cookie,
					origin: "https://comms.test",
					"content-type": "application/json",
					"X-Chirp-Assertion": proof,
				},
				body: JSON.stringify({ backup: saved.id }),
			});
		await writeFile(armed, "pause this restore only");
		const pending = request(app.url).catch(() => null);
		await expect.poll(() => readFile(reached, "utf8").catch(() => ""), { timeout: 15000 }).toBe(phase);
		expect(await fixture.sql("SELECT phase FROM db_restore_requests", "boot.db")).toEqual([{ phase }]);
		// At restoring the prior owner has already closed; at working/restored
		// the candidate owns the selected file and its keeper must close on EOF.
		expect(
			await fixture.sql("SELECT COUNT(*) count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
		).toEqual([{ count: phase === "restoring" ? 0 : 1 }]);
		await app.stop("SIGKILL");
		await pending;
		let legacyArtifact: Buffer | undefined;
		if (checkpoint === "legacy-restoring") {
			// Reconstruct a catalog authorized at successful legacy adoption; preserve the finalized live identity.
			await fixture.sql(
				"UPDATE backups SET legacy_store_id=(SELECT value FROM settings WHERE key='app_store_id')",
				"boot.db",
			);
			for (const item of await fixture.backups())
				await fixture.sql("DROP TABLE store_identity", `backups/${item.id}.db`);
			legacyArtifact = await readFile(saved.path);
		}
		await rm(armed);
		const resumed = await fixture.launch();
		await resumed.ready(cookie);
		if (legacyArtifact) expect(await readFile(saved.path)).toEqual(legacyArtifact);
		const expected =
			phase === "working" ? [{ body: "A before backup" }, { body: "B before restore" }] : [{ body: "A before backup" }];
		expect(await fixture.sql("SELECT body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(expected);
		const receipt: unknown = await (await request(resumed.url)).json();
		expect(receipt).toMatchObject({ status: phase === "working" ? "failed" : "restored", backup: saved.id });
		expect((await resumed.post("/api/messages", { topic: "restore", body: "C after recovery" }, cookie)).status).toBe(
			200,
		);
		const fresh = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
		expect(await (await request(resumed.url)).json()).toEqual(receipt);
		expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(fresh);
		await resumed.stop("SIGKILL");
		const again = await fixture.launch();
		await again.ready(cookie);
		expect(await (await request(again.url)).json()).toEqual(receipt);
		expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(fresh);
		expect(
			await fixture.sql(
				"SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='db.restored'",
				"boot.db",
			),
		).toEqual([{ count: phase === "working" ? 0 : 1 }]);
		expect(
			await fixture.sql("SELECT COUNT(*) count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
		).toEqual([{ count: 1 }]);
	},
);
