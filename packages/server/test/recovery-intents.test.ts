import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

const insertCutover =
	"INSERT INTO cutover(singleton,candidate,lock_id,family,phase) VALUES(1,1,'fixture','fixture','restoring')";
const insertRestore =
	"INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,restored_to_seq) VALUES('fixture','hash','fixture','backup','restoring',0)";
const insertMove = "INSERT INTO topic_moves VALUES('fixture','old','new','fixture',NULL,'{}','prepared',NULL)";
const insertSource = "INSERT INTO source_batches VALUES('fixture',NULL,'fixture',0,'publishing')";

it.for([
	[insertCutover, insertRestore],
	[insertCutover, insertMove],
	[insertRestore, insertMove],
	[insertRestore, insertSource],
	[insertCutover, insertSource],
	[insertMove, insertSource],
] as const)(
	"refuses conflicting recovery intents before changing either store or source",
	{ timeout: 30000 },
	async (inserts, test) => {
		const fixture = await conversation(test);
		const app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		expect((await app.post("/api/messages", { topic: "old", body: "acknowledged" }, cookie)).status).toBe(200);
		await mkdir(join(fixture.root, "pages/old"), { recursive: true });
		await writeFile(join(fixture.root, "pages/old/index.md"), "page before conflict");
		await app.stop();
		for (const statement of inserts) await fixture.sql(statement, "boot.db");
		const appBefore = await readFile(join(fixture.root, "comms.db"));
		const sourceBefore = await readFile(join(fixture.root, "app/server.ts"));
		const receiptsBefore = await fixture.sql("SELECT * FROM child_attempts", "boot.db");
		const generationsBefore = await fixture.sql("SELECT * FROM generations", "boot.db");
		const restarted = await fixture.launch();
		await expect
			.poll(
				async () =>
					(await (await fetch(`${restarted.url}/_boot/status`, { headers: { cookie } })).json()).source_recovery_error,
				{ timeout: 10000 },
			)
			.toContain("Conflicting recovery intents");
		expect((await fetch(`${restarted.url}/_boot/db/backups`, { headers: { cookie } })).status).toBe(200);
		expect((await fetch(`${restarted.url}/api/messages?since=0`, { headers: { cookie } })).status).toBe(503);
		expect(
			(
				await fetch(`${restarted.url}/api/fs/pages/old/index.md`, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test", "content-type": "text/plain" },
					body: "must not publish",
				})
			).status,
		).toBe(503);
		expect(await readFile(join(fixture.root, "comms.db"))).toEqual(appBefore);
		expect(await readFile(join(fixture.root, "app/server.ts"))).toEqual(sourceBefore);
		expect(await readFile(join(fixture.root, "pages/old/index.md"), "utf8")).toBe("page before conflict");
		expect(await fixture.sql("SELECT * FROM child_attempts", "boot.db")).toEqual(receiptsBefore);
		expect(await fixture.sql("SELECT * FROM generations", "boot.db")).toEqual(generationsBefore);
	},
);

it.for([insertCutover, insertRestore, insertMove, insertSource] as const)(
	"refuses new recovery operations while a durable owner is pending",
	{ timeout: 30000 },
	async (pending, test) => {
		const fixture = await conversation(test);
		const app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		expect((await app.post("/api/messages", { topic: "old", body: "preserve" }, cookie)).status).toBe(200);
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		const backup = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const proof = await app.signedAssertion("db.restore", { backup }, cookie);
		await fixture.sql(pending, "boot.db");
		const generations = await fixture.sql("SELECT * FROM generations", "boot.db");
		const batches = await fixture.sql("SELECT * FROM source_batches", "boot.db");
		const ownership = await fixture.sql("SELECT * FROM child_attempts", "boot.db");
		const restores = await fixture.sql("SELECT * FROM db_restore_requests", "boot.db");
		expect((await app.post("/api/reload", {}, cookie)).status).toBe(503);
		expect((await app.post("/api/topics/old/move", { to: "new" }, cookie)).status).toBe(503);
		expect(
			(
				await fetch(`${app.url}/api/fs/pages/old/index.md`, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test" },
					body: "do not write",
				})
			).status,
		).toBe(503);
		if (pending !== insertRestore)
			expect(
				(
					await fetch(`${app.url}/_boot/db/restore`, {
						method: "POST",
						headers: {
							cookie,
							origin: "https://comms.test",
							"content-type": "application/json",
							"x-comms-assertion": proof,
						},
						body: JSON.stringify({ backup }),
					})
				).status,
			).toBe(503);
		expect(await fixture.sql("SELECT * FROM db_restore_requests", "boot.db")).toEqual(restores);
		expect(await fixture.sql("SELECT * FROM generations", "boot.db")).toEqual(generations);
		expect(await fixture.sql("SELECT * FROM source_batches", "boot.db")).toEqual(batches);
		expect(await fixture.sql("SELECT * FROM child_attempts", "boot.db")).toEqual(ownership);
		expect(await fixture.sql("SELECT body FROM messages")).toEqual([{ body: "preserve" }]);
	},
);
