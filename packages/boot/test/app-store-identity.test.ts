import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, type TestContext } from "vitest";

async function fixture(test: TestContext, productionCrash = false, liveFile = "comms.db") {
	const root = await mkdtemp(join(tmpdir(), "comms-identity-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, liveFile, ".."), { recursive: true });
	let script = join(import.meta.dirname, "fixtures/app-store-identity.ts");
	if (productionCrash) {
		const boot = join(root, "packages/boot");
		await cp(join(import.meta.dirname, "../src"), join(boot, "src"), { recursive: true });
		await mkdir(join(boot, "test/fixtures"), { recursive: true });
		const copy = join(boot, "test/fixtures/app-store-identity.ts");
		await cp(script, copy);
		script = copy;
		await symlink(join(import.meta.dirname, "../node_modules"), join(boot, "node_modules"));
		const recovery = join(boot, "src/app-recovery.ts");
		const source = await readFile(recovery, "utf8");
		const needle = "yield* identity.complete(adoption);";
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			recovery,
			source.replace(
				needle,
				`if (yield* fs.exists(${JSON.stringify(join(root, "armed"))})) { yield* Effect.log("PAUSED"); yield* Effect.never; }
${needle}`,
			),
		);
		const backup = join(boot, "src/db-ops.ts");
		const backupSource = await readFile(backup, "utf8");
		const copied = "yield* fs.copyFile(backup.path, temporary);";
		expect(backupSource.split(copied)).toHaveLength(2);
		await writeFile(
			backup,
			backupSource.replace(
				copied,
				`${copied}
if (yield* fs.exists(${JSON.stringify(join(root, "restore-armed"))})) { yield* Effect.log("PAUSED"); yield* Effect.never; }`,
			),
		);
	}
	const execute = promisify(execFile);
	const run = async (mode = "prepare") => (await execute("bun", [script, root, mode, liveFile])).stdout;
	const sql = async (statement: string, file = "boot.db") => {
		let result: unknown = [];
		for (const query of statement.split(";").filter((part) => part.trim()))
			result = JSON.parse(
				(
					await execute("bun", [
						join(import.meta.dirname, "fixtures/store.ts"),
						join(root, file === "comms.db" ? liveFile : file),
						query,
					])
				).stdout,
			);
		return result;
	};
	const crash = async (mode: string) => {
		const child = spawn("bun", [script, root, mode, liveFile], { stdio: ["ignore", "pipe", "pipe"] });
		test.onTestFinished(() => {
			child.kill("SIGKILL");
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += String(chunk);
		});
		await expect.poll(() => output, { timeout: 5000 }).toContain("PAUSED");
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
	};
	const legacy = async () => {
		expect(await run()).toContain('"Success"');
		await sql("DELETE FROM settings WHERE key IN ('app_store_adoption','app_store_id')");
		await sql(
			"DROP TABLE store_identity; CREATE TABLE messages(id TEXT PRIMARY KEY,body TEXT); INSERT INTO messages VALUES('ack','retained');",
			"comms.db",
		);
		await mkdir(join(root, "pages"));
		await writeFile(join(root, "pages/kept.md"), "retained page");
		await sql("INSERT INTO sessions(id,hash,created_at,expires_at) VALUES('identity','credential',1,9000000000000)");
	};
	return { root, run, sql, crash, legacy };
}

it.for(["reserve", "stamp"])(
	"resumes legacy identity after SIGKILL at %s without choosing another UUID",
	async (mode, test) => {
		const app = await fixture(test);
		await app.legacy();
		await app.crash(mode);
		const pending = await app.sql(
			"SELECT json_extract(value,'$.store_id') AS id FROM settings WHERE key='app_store_adoption'",
		);
		expect(await app.run()).toContain('"Success"');
		expect(await app.sql("SELECT value AS id FROM settings WHERE key='app_store_id'")).toEqual(pending);
		expect(await app.sql("SELECT store_id AS id FROM store_identity", "comms.db")).toEqual(pending);
		expect(await app.sql("SELECT * FROM messages", "comms.db")).toEqual([{ id: "ack", body: "retained" }]);
		expect(await app.sql("SELECT id,hash FROM sessions")).toEqual([{ id: "identity", hash: "credential" }]);
		expect(await readFile(join(app.root, "pages/kept.md"), "utf8")).toBe("retained page");
	},
);

it("creates a fresh pair and refuses missing, foreign and malformed finalized identity before the fence changes", async (test) => {
	const app = await fixture(test);
	expect(await app.run()).toContain('"Success"');
	await app.sql("UPDATE kernel_writer SET epoch='unchanged'; UPDATE store_identity SET store_id='foreign'", "comms.db");
	expect(await app.run()).toContain("app_store_mismatch");
	expect(await app.sql("SELECT epoch FROM kernel_writer", "comms.db")).toEqual([{ epoch: "unchanged" }]);
	await app.sql("DROP TABLE store_identity", "comms.db");
	expect(await app.run()).toContain("app_store_missing");
	expect(await app.sql("SELECT name FROM sqlite_master WHERE name='store_identity'", "comms.db")).toEqual([]);
	await rm(join(app.root, "comms.db"));
	expect(await app.run()).toContain("app_store_missing");
	await expect(readFile(join(app.root, "comms.db"))).rejects.toThrow();
});

it("restores only catalog-authorized legacy copies, retaining original bytes across rename and restart", async (test) => {
	const app = await fixture(test);
	await app.legacy();
	await mkdir(join(app.root, "backups"));
	const target = join(app.root, "backups/saved.db");
	await app.sql(`VACUUM INTO '${target}'`, "comms.db");
	await app.sql(
		`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through) VALUES('saved','${target}','pre-flip',100,1,0)`,
	);
	const original = await readFile(target);
	expect(await app.run()).toContain('"Success"');
	await app.sql("UPDATE messages SET body='newer'", "comms.db");
	// A prior fixed-name temp and its stale journal must never be opened or reused.
	await writeFile(join(app.root, "comms.db.restore"), "abandoned");
	await writeFile(join(app.root, "comms.db.restore-journal"), "stale journal");
	await app.crash("restore-pause");
	expect(await app.run()).toContain('"Success"');
	expect(await readFile(target)).toEqual(original);
	expect(await app.run("sweep")).toContain('"Success"');
	await expect(readFile(join(app.root, "comms.db.restore-journal"))).rejects.toThrow();
	await expect(readFile(join(app.root, "comms.db.restore"))).rejects.toThrow();
	expect(await app.sql("SELECT body FROM messages", "comms.db")).toEqual([{ body: "retained" }]);
	await app.sql("UPDATE backups SET legacy_store_id=NULL WHERE id='saved'");
	await app.sql("UPDATE messages SET body='acknowledged after restore'", "comms.db");
	expect(await app.run("restore")).toContain("app_store_missing");
	expect(await app.sql("SELECT body FROM messages", "comms.db")).toEqual([{ body: "acknowledged after restore" }]);
});

it.for(["comms.db", "store/comms.db"])(
	"permits a validated journal replacement for missing %s",
	async (liveFile, test) => {
		const app = await fixture(test, false, liveFile);
		await app.legacy();
		await mkdir(join(app.root, "backups"));
		const target = join(app.root, "backups/saved.db");
		await app.sql(`VACUUM INTO '${target}'`, "comms.db");
		await app.sql(
			`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through) VALUES('saved','${target}','pre-flip',100,1,0)`,
		);
		expect(await app.run()).toContain('"Success"');
		await rm(join(app.root, liveFile));
		expect(await app.run()).toContain("app_store_missing");
		await app.sql(
			"INSERT INTO cutover(singleton,candidate,backup,lock_id,family,phase) VALUES(1,1,'saved','lock','family','restoring')",
		);
		// Reservation alone cannot initialize the absent app store, even with a valid selected backup.
		expect(await app.run()).toContain("app_store_missing");
		await expect(readFile(join(app.root, liveFile))).rejects.toThrow();
		expect(await app.run("restore")).toContain('"Success"');
		expect(await app.sql("SELECT body FROM messages", "comms.db")).toEqual([{ body: "retained" }]);
	},
);

it("refuses foreign and malformed backup identity without replacing the live store", async (test) => {
	const app = await fixture(test);
	await app.legacy();
	expect(await app.run()).toContain('"Success"');
	await mkdir(join(app.root, "backups"));
	const target = join(app.root, "backups/saved.db");
	await app.sql(`VACUUM INTO '${target}'`, "comms.db");
	await app.sql(
		`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through) VALUES('saved','${target}','pre-flip',100,1,0)`,
	);
	await app.sql("UPDATE store_identity SET store_id='foreign'", "backups/saved.db");
	const before = await readFile(join(app.root, "comms.db"));
	expect(await app.run("restore")).toContain("app_store_mismatch");
	expect(await readFile(join(app.root, "comms.db"))).toEqual(before);
	await app.sql("ALTER TABLE store_identity DROP COLUMN initialized_at", "backups/saved.db");
	expect(await app.run("restore")).toContain("app_store_identity_invalid");
	expect(await readFile(join(app.root, "comms.db"))).toEqual(before);
});

it("SIGKILL after the real recovery app commit retains identity, fence and pending evidence until restart", async (test) => {
	const app = await fixture(test, true);
	await app.legacy();
	await app.sql("UPDATE seq SET next=2,pending_id='pending',pending_attempt='old',pending_from=1,pending_to=1");
	await app.sql("INSERT INTO event_batches VALUES('pending','old',1,1,'pending')");
	const event = JSON.stringify({
		seq: 1,
		at: 1,
		type: "message.created",
		level: "info",
		actor: "rahul",
		instance: null,
		generation: 1,
		request_id: null,
		topic: "retained",
		message_id: "ack",
		payload: { body: "retained" },
	});
	await app.sql("INSERT INTO mutation_batches VALUES('pending',1,1,1)", "comms.db");
	await app.sql(`INSERT INTO outbox VALUES(1,'pending','${event}',NULL)`, "comms.db");
	await writeFile(join(app.root, "armed"), "pause");
	await app.crash("prepare");
	expect(await app.sql("SELECT epoch FROM kernel_writer", "comms.db")).toEqual([{ epoch: "next-epoch" }]);
	const identity = await app.sql("SELECT store_id FROM store_identity", "comms.db");
	expect(await app.sql("SELECT pending_id FROM seq")).toEqual([{ pending_id: "pending" }]);
	expect(await app.sql("SELECT key FROM settings WHERE key='app_store_id'")).toEqual([]);
	await rm(join(app.root, "armed"));
	expect(await app.run()).toContain('"Success"');
	expect(await app.sql("SELECT store_id FROM store_identity", "comms.db")).toEqual(identity);
	expect(await app.sql("SELECT state FROM event_batches WHERE id='pending'")).toEqual([{ state: "published" }]);
	expect(await app.sql("SELECT body FROM messages", "comms.db")).toEqual([{ body: "retained" }]);
});

it("does not authorize legacy backups until adoption completes, or overwrite prior provenance", async (test) => {
	const app = await fixture(test);
	await app.legacy();
	await app.sql(
		"INSERT INTO backups(id,path,reason,bytes,taken_at,legacy_store_id) VALUES('old','unused','pre-flip',1,1,'prior-board'),('pending','unused','pre-flip',1,1,NULL)",
	);
	await app.crash("reserve");
	expect(await app.sql("SELECT legacy_store_id FROM backups ORDER BY id")).toEqual([
		{ legacy_store_id: "prior-board" },
		{ legacy_store_id: null },
	]);
	expect(await app.run()).toContain('"Success"');
	const identity = await app.sql("SELECT value AS legacy_store_id FROM settings WHERE key='app_store_id'");
	expect(await app.sql("SELECT legacy_store_id FROM backups WHERE id='pending'")).toEqual(identity);
	expect(await app.sql("SELECT legacy_store_id FROM backups WHERE id='old'")).toEqual([
		{ legacy_store_id: "prior-board" },
	]);
	await app.sql("INSERT INTO backups(id,path,reason,bytes,taken_at) VALUES('later','unused','manual',1,1)");
	expect(await app.run()).toContain('"Success"');
	expect(await app.sql("SELECT legacy_store_id FROM backups WHERE id='later'")).toEqual([{ legacy_store_id: null }]);
});

it("preserves an unadopted legacy restore journal without inventing backup provenance", async (test) => {
	const app = await fixture(test);
	await app.legacy();
	await mkdir(join(app.root, "backups"));
	const target = join(app.root, "backups/saved.db");
	await app.sql(`VACUUM INTO '${target}'`, "comms.db");
	await app.sql(
		`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through) VALUES('saved','${target}','pre-flip',100,1,0)`,
	);
	await app.sql(
		"INSERT INTO cutover(singleton,candidate,backup,lock_id,family,phase) VALUES(1,1,'saved','lock','family','restoring')",
	);
	await rm(join(app.root, "comms.db"));
	const original = await readFile(target);
	expect(await app.run("restore")).toContain("app_store_missing");
	expect(await readFile(target)).toEqual(original);
	await expect(readFile(join(app.root, "comms.db"))).rejects.toThrow();
	expect(await app.sql("SELECT legacy_store_id FROM backups")).toEqual([{ legacy_store_id: null }]);
	expect(await app.sql("SELECT phase FROM cutover")).toEqual([{ phase: "restoring" }]);
});

it("reclaims a killed restore copy before retry without accumulating board copies", async (test) => {
	const app = await fixture(test, true);
	expect(await app.run()).toContain('"Success"');
	await mkdir(join(app.root, "backups"));
	const target = join(app.root, "backups/saved.db");
	await app.sql(`VACUUM INTO '${target}'`, "comms.db");
	await app.sql(
		`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through) VALUES('saved','${target}','pre-flip',100,1,0)`,
	);
	const original = await readFile(target);
	await writeFile(join(app.root, "restore-armed"), "pause");
	for (let attempt = 0; attempt < 2; attempt++) {
		await app.crash("restore");
		expect(await readFile(join(app.root, "comms.db.restore-staging/store.db"))).toEqual(original);
	}
	await rm(join(app.root, "restore-armed"));
	expect(await app.run("sweep")).toContain('"Success"');
	await expect(readFile(join(app.root, "comms.db.restore-staging/store.db"))).rejects.toThrow();
	expect(await readFile(target)).toEqual(original);
	expect(await app.run("restore")).toContain('"Success"');
});

it.for(["cutover", "restore"])(
	"refuses a preidentity %s upgrade without changing boot schema or journal bytes",
	async (kind, test) => {
		const app = await fixture(test);
		await app.legacy();
		await app.sql("DROP TABLE IF EXISTS boot_migrations");
		await app.sql("ALTER TABLE backups DROP COLUMN legacy_store_id; PRAGMA user_version=16");
		if (kind === "cutover")
			await app.sql(
				"INSERT INTO cutover(singleton,candidate,backup,lock_id,family,phase) VALUES(1,1,'saved','lock','family','restoring')",
			);
		else
			await app.sql(
				"INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,restored_to_seq) VALUES('proof','hash','session','saved','rollback',0)",
			);
		const before = await readFile(join(app.root, "boot.db"));
		expect(await app.run()).toContain("BootIdentityUpgradePending");
		expect(await readFile(join(app.root, "boot.db"))).toEqual(before);
		expect(await app.sql("PRAGMA user_version")).toEqual([{ user_version: 16 }]);
		expect(await app.sql("SELECT name FROM pragma_table_info('backups') WHERE name='legacy_store_id'")).toEqual([]);
	},
);

it.for(["pg", "mysql"])("refuses a %s selected backup as authority to adopt a missing store", async (engine, test) => {
	const app = await fixture(test);
	await app.legacy();
	await mkdir(join(app.root, "backups"));
	const target = join(app.root, "backups/saved.db");
	await app.sql(`VACUUM INTO '${target}'`, "comms.db");
	await app.sql(
		`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through,engine) VALUES('saved','${target}','pre-flip',100,1,0,'${engine}')`,
	);
	await app.sql(
		"INSERT INTO cutover(singleton,candidate,backup,lock_id,family,phase) VALUES(1,1,'saved','lock','family','restoring')",
	);
	await rm(join(app.root, "comms.db"));
	const before = await readFile(target);
	expect(await app.run("restore")).toContain("app_store_missing");
	expect(await app.sql("SELECT key FROM settings WHERE key IN ('app_store_adoption','app_store_id')")).toEqual([]);
	expect(await app.sql("SELECT legacy_store_id FROM backups WHERE id='saved'")).toEqual([{ legacy_store_id: null }]);
	await expect(readFile(join(app.root, "comms.db"))).rejects.toThrow();
	expect(await readFile(target)).toEqual(before);
});

it("stamps legacy provenance only for SQLite backups during adoption", async (test) => {
	const app = await fixture(test);
	await app.legacy();
	await app.sql(
		"INSERT INTO backups(id,path,reason,bytes,taken_at,engine) VALUES('sqlite','/unopened/sqlite.db','pre-flip',100,1,'sqlite'),('pg','/unopened/pg','pre-flip',100,1,'pg'),('mysql','/unopened/mysql','pre-flip',100,1,'mysql')",
	);
	expect(await app.run()).toContain('"Success"');
	expect(await app.sql("SELECT id,legacy_store_id FROM backups WHERE engine!='sqlite' ORDER BY id")).toEqual([
		{ id: "mysql", legacy_store_id: null },
		{ id: "pg", legacy_store_id: null },
	]);
	expect(await app.sql("SELECT legacy_store_id AS id FROM backups WHERE engine='sqlite'")).toEqual(
		await app.sql("SELECT value AS id FROM settings WHERE key='app_store_id'"),
	);
});

it.for(["cutover", "restore"])("refuses a v17 %s upgrade before stamping backup engines", async (kind, test) => {
	const app = await fixture(test);
	expect(await app.run()).toContain('"Success"');
	await app.sql("DROP TABLE boot_migrations");
	await app.sql("ALTER TABLE backups DROP COLUMN engine; PRAGMA user_version=17");
	if (kind === "cutover")
		await app.sql(
			"INSERT INTO cutover(singleton,candidate,backup,lock_id,family,phase) VALUES(1,1,'saved','lock','family','restoring')",
		);
	else
		await app.sql(
			"INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,restored_to_seq) VALUES('proof','hash','session','saved','restoring',0)",
		);
	const before = await readFile(join(app.root, "boot.db"));
	expect(await app.run()).toContain("BootIdentityUpgradePending");
	expect(await readFile(join(app.root, "boot.db"))).toEqual(before);
	expect(await app.sql("PRAGMA user_version")).toEqual([{ user_version: 17 }]);
	expect(await app.sql("SELECT name FROM pragma_table_info('backups') WHERE name='engine'")).toEqual([]);
});

it("accepts finalized identity relocation while retaining the original adoption path", async (test) => {
	const app = await fixture(test);
	expect(await app.run()).toContain('"Success"');
	const before = await app.sql("SELECT value FROM settings WHERE key='app_store_adoption'");
	await mkdir(join(app.root, "store"));
	await rename(join(app.root, "comms.db"), join(app.root, "store/comms.db"));
	expect(await app.run("relocated")).toContain('"Success"');
	expect(await app.sql("SELECT value FROM settings WHERE key='app_store_adoption'")).toEqual(before);
});

it("refuses pending adoption relocation without stamping the moved store", async (test) => {
	const app = await fixture(test);
	await app.legacy();
	await app.crash("reserve");
	await mkdir(join(app.root, "store"));
	await rename(join(app.root, "comms.db"), join(app.root, "store/comms.db"));
	const before = await readFile(join(app.root, "store/comms.db"));
	expect(await app.run("relocated")).toContain("app_store_identity_invalid");
	expect(await readFile(join(app.root, "store/comms.db"))).toEqual(before);
});

it("refuses app evidence ahead of a replaced boot allocator before stamping or fencing", async (test) => {
	const app = await fixture(test);
	await app.legacy();
	await app.sql("DELETE FROM settings WHERE key='app_store_initialized'");
	await app.sql(
		"INSERT INTO mutation_batches VALUES('old',1,3,3); UPDATE kernel_writer SET epoch='unchanged'",
		"comms.db",
	);
	expect(await app.run()).toContain("app_evidence_invalid");
	expect(await app.sql("SELECT epoch FROM kernel_writer", "comms.db")).toEqual([{ epoch: "unchanged" }]);
	expect(await app.sql("SELECT name FROM sqlite_master WHERE name='store_identity'", "comms.db")).toEqual([]);
});

it("codes malformed store shape in both legacy and pending fresh adoption", async (test) => {
	const app = await fixture(test);
	await app.crash("reserve");
	await app.sql("CREATE TABLE unrelated(value TEXT)", "comms.db");
	expect(await app.run()).toContain("app_store_identity_invalid");
	expect(await app.sql("SELECT name FROM sqlite_master WHERE name='store_identity'", "comms.db")).toEqual([]);
	await app.sql(
		"DELETE FROM settings WHERE key='app_store_adoption'; INSERT INTO settings(key,value) VALUES('app_store_initialized','1')",
	);
	expect(await app.run()).toContain("app_store_identity_invalid");
});

it.for(["cutover", "restore"])("refuses a v18 %s upgrade before enabling copy-owner recovery", async (kind, test) => {
	const app = await fixture(test);
	expect(await app.run()).toContain('"Success"');
	await app.sql("DROP TABLE boot_migrations");
	await app.sql("PRAGMA user_version=18");
	if (kind === "cutover")
		await app.sql(
			"INSERT INTO cutover(singleton,candidate,backup,lock_id,family,phase) VALUES(1,1,'saved','lock','family','restoring')",
		);
	else
		await app.sql(
			"INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,restored_to_seq) VALUES('proof','hash','session','saved','restoring',0)",
		);
	const before = await readFile(join(app.root, "boot.db"));
	expect(await app.run()).toContain("BootIdentityUpgradePending");
	expect(await readFile(join(app.root, "boot.db"))).toEqual(before);
	expect(await app.sql("PRAGMA user_version")).toEqual([{ user_version: 18 }]);
});

it("refuses an existing legacy store after all publication evidence was pruned and boot was replaced", async (test) => {
	const app = await fixture(test);
	await app.legacy();
	await app.sql(
		"DELETE FROM outbox; DELETE FROM mutation_batches; UPDATE kernel_writer SET epoch='retained-owner'",
		"comms.db",
	);
	await app.sql("DELETE FROM settings WHERE key='app_store_initialized'");
	const bootBefore = await readFile(join(app.root, "boot.db"));
	const appBefore = await readFile(join(app.root, "comms.db"));
	expect(await app.run()).toContain("app_evidence_invalid");
	expect(await readFile(join(app.root, "boot.db"))).toEqual(bootBefore);
	expect(await readFile(join(app.root, "comms.db"))).toEqual(appBefore);
	expect(await app.sql("SELECT epoch FROM kernel_writer", "comms.db")).toEqual([{ epoch: "retained-owner" }]);
	expect(await app.sql("SELECT * FROM messages", "comms.db")).toEqual([{ id: "ack", body: "retained" }]);
	expect(
		await app.sql(
			"SELECT key FROM settings WHERE key IN ('app_store_adoption','app_store_id','app_store_initialized')",
		),
	).toEqual([]);
	expect(await app.sql("SELECT name FROM sqlite_master WHERE name='store_identity'", "comms.db")).toEqual([]);
});

it("resumes a reserved fresh adoption after the app commit before the initialized marker", async (test) => {
	const app = await fixture(test, true);
	await writeFile(join(app.root, "armed"), "pause");
	await app.crash("prepare");
	const identity = await app.sql("SELECT store_id AS id FROM store_identity", "comms.db");
	expect(await app.sql("SELECT key FROM settings WHERE key='app_store_initialized'")).toEqual([]);
	await rm(join(app.root, "armed"));
	expect(await app.run()).toContain('"Success"');
	expect(await app.sql("SELECT value AS id FROM settings WHERE key='app_store_id'")).toEqual(identity);
});
