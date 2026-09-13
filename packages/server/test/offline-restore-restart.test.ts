import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { storageFixture } from "./fixtures/storage-maintenance.ts";

for (const checkpoint of ["before-record", "restoring", "working", "hot-journal"] as const)
	it(`offline preservation survives ${checkpoint} without granting authority to prior bytes`, async (test) => {
		const fixture = await storageFixture(test);
		const coordinator = join(fixture.root, "packages/boot/src/database-restore.ts");
		const source = await readFile(coordinator, "utf8");
		const armed = join(fixture.root, "offline-armed");
		const reached = join(fixture.root, "offline-reached");
		if (checkpoint !== "hot-journal") {
			const needle =
				checkpoint === "before-record"
					? "yield* beforeImage.record(record.proof_id, preserved);"
					: checkpoint === "restoring"
						? "const restored = yield* backup.restoreInto(target);"
						: 'yield* candidate.process.health.pipe(Effect.timeout("5 seconds"));';
			expect(source.split(needle)).toHaveLength(2);
			await writeFile(
				coordinator,
				source.replace(
					needle,
					`if (yield* fs.exists(${JSON.stringify(armed)})) {
 yield* fs.writeFileString(${JSON.stringify(reached)}, "paused"); yield* Effect.never;
}
${needle}`,
				),
			);
		}
		const app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		expect((await app.post("/api/messages", { topic: "offline", body: "retained" }, cookie)).status).toBe(200);
		await fixture.force("hourly");
		await expect.poll(async () => (await fixture.backups()).length).toBe(1);
		await fixture.cycle();
		const [saved] = await fixture.backups();
		if (!saved) throw Error("Missing backup");
		await app.stop();
		await fixture.sql("UPDATE store_identity SET store_id='foreign-board'");
		const resumed = await fixture.launch();
		await expect
			.poll(async () => (await fixture.status(resumed.url, cookie)).child.state, { timeout: 15000 })
			.toBe("failed");
		if (checkpoint === "hot-journal") {
			// Failed is also shown between startup attempts. Wait for all three owners to close
			// before introducing a closed-store crash artifact.
			await expect
				.poll(async () => await (await fetch(`${resumed.url}/_boot/status`, { headers: { cookie } })).json(), {
					timeout: 15000,
				})
				.toMatchObject({ child: { state: "failed", attempt: 3 } });
			const child = spawn(
				"bun",
				[
					"-e",
					`import { Database } from 'bun:sqlite';
const db = new Database(process.argv[1]);
db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE');
db.query('UPDATE messages SET body=? WHERE topic=?').run('x'.repeat(2097152),'offline');
console.log('HOT'); setInterval(()=>{},1000);`,
					join(fixture.root, "comms.db"),
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			test.onTestFinished(() => {
				child.kill("SIGKILL");
			});
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			await expect.poll(() => output).toContain("HOT");
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
			const journal = await readFile(join(fixture.root, "comms.db-journal"));
			expect(journal.subarray(0, 8).toString("hex")).toBe("d9d505f920a163d7");
		}
		const before = await readFile(join(fixture.root, "comms.db"));
		const beforeJournal = await readFile(join(fixture.root, "comms.db-journal")).catch(() => null);
		const proof = await resumed.signedAssertion("db.restore", { backup: saved.id }, cookie);
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
		if (checkpoint === "hot-journal") {
			expect((await request(resumed.url)).status).toBe(200);
			await resumed.ready(cookie);
			expect(await fixture.sql("SELECT body FROM messages WHERE topic='offline'")).toEqual([{ body: "retained" }]);
			const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ value: Schema.String })))(
				await fixture.sql("SELECT value FROM settings WHERE key LIKE 'restore-before:%'", "boot.db"),
			);
			const manifest = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ artifact: Schema.String })))(
				rows[0]?.value ?? "",
			);
			expect(await readFile(join(fixture.root, "restore-before", manifest.artifact, "comms.db"))).toEqual(before);
			expect(await readFile(join(fixture.root, "restore-before", manifest.artifact, "comms.db-journal"))).toEqual(
				beforeJournal,
			);
			return;
		}
		await writeFile(armed, "armed");
		const pending = request(resumed.url).catch(() => null);
		await expect.poll(() => readFile(reached, "utf8").catch(() => ""), { timeout: 15000 }).toBe("paused");
		await resumed.stop("SIGKILL");
		await pending;
		await rm(armed);
		const priorAttempts = await fixture.sql("SELECT COUNT(*) AS n FROM child_attempts", "boot.db");
		const restarted = await fixture.launch();
		if (checkpoint === "restoring") {
			await restarted.ready(cookie);
			expect(await fixture.sql("SELECT body FROM messages WHERE topic='offline'")).toEqual([{ body: "retained" }]);
		} else {
			// Before recording, no replacement was selected: ordinary startup still performs
			// its three identity-refused attempts. An opaque rollback must launch none.
			await expect
				.poll(async () => await (await fetch(`${restarted.url}/_boot/status`, { headers: { cookie } })).json(), {
					timeout: 15000,
				})
				.toMatchObject({ child: { state: "failed", attempt: checkpoint === "before-record" ? 3 : 0 } });
			if (checkpoint === "working")
				expect(await fixture.sql("SELECT COUNT(*) AS n FROM child_attempts", "boot.db")).toEqual(priorAttempts);
			expect((await fetch(`${restarted.url}/api/messages?since=0`, { headers: { cookie } })).status).toBe(503);
			expect(await readFile(join(fixture.root, "comms.db"))).toEqual(before);
			expect(
				await fixture.sql("SELECT COUNT(*) AS n FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
			).toEqual([{ n: 0 }]);
		}
	}, 45000);
