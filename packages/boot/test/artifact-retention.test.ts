import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";

const execute = promisify(execFile);
async function store(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-artifacts-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const invoke = async (name: string, args: readonly string[]) => {
		const { stdout } = await execute("bun", [join(import.meta.dirname, `fixtures/${name}.ts`), ...args]);
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
	};
	const prune = (input: unknown = { capacity: 1000 }) => invoke("artifact-retention", [root, JSON.stringify(input)]);
	await prune();
	await mkdir(join(root, "backups"));
	await mkdir(join(root, "gen"));
	const sql = (statement: string) => invoke("store", [join(root, "boot.db"), statement]);
	const backup = async (id: string, reason = "hourly", generation: number | null = 99, at = 1) => {
		await writeFile(join(root, "backups", `${id}.db`), "retained-data");
		await sql(
			`INSERT INTO backups VALUES('${id}','${root}/backups/${id}.db','${reason}',100,${at},${generation === null ? "NULL" : "0"},${generation ?? "NULL"})`,
		);
	};
	const generation = async (n: number, status = "retired", good = 1, partial = false) => {
		await mkdir(join(root, "gen", String(n), partial ? ".partial" : "source"), { recursive: true });
		await sql(`INSERT INTO generations(n,snapshot_dir,entry_file,status,good,started_at)
			VALUES(${n},${partial ? "NULL" : `'${root}/gen/${n}/source'`},'main.ts','${status}',${good},0)`);
	};
	const exists = async (relative: string) =>
		access(join(root, relative)).then(
			() => true,
			() => false,
		);
	return { root, prune, sql, backup, generation, exists };
}

it("removes oldest hourly copies before obsolete pre-flip copies and reserves the requested bytes", async (test) => {
	const app = await store(test);
	await app.backup("pre", "pre-flip", 1, 0);
	await app.backup("new", "hourly", 1, 3);
	await app.backup("old", "hourly", 1, 2);
	expect(await app.prune({ capacity: 1500, required: 100 })).toMatchObject({
		success: { backup_bytes: 200, removed_backups: 1 },
	});
	expect(await app.exists("backups/old.db")).toBe(false);
	expect(await app.exists("backups/pre.db")).toBe(true);
	expect(await app.prune({ capacity: 500, required: 100 })).toMatchObject({
		success: { backup_bytes: 0, removed_backups: 2 },
	});
	expect(await app.sql("SELECT * FROM backups")).toEqual([]);
});

it("protects five good generations, live, starting, keeper owners and both recovery journals", async (test) => {
	const app = await store(test);
	for (let n = 1; n <= 8; n++) await app.generation(n);
	await app.generation(9, "live", 0);
	await app.sql(
		"INSERT INTO child_attempts(id,generation,receipt,opened,closed) VALUES('current',9,'current-receipt',1,0)",
	);
	await app.generation(10, "starting", 0);
	await app.sql(
		"INSERT INTO child_attempts(id,generation,receipt,opened,closed) VALUES('prewarm',10,'prewarm-receipt',0,0)",
	);
	await app.generation(11, "failed", 0, true);
	await app.sql("INSERT INTO child_attempts(id,generation,receipt,opened,closed) VALUES('keeper',1,'receipt',1,0)");
	await app.sql("INSERT INTO cutover VALUES(1,2,3,'cutover','lock','family','frozen',NULL)");
	await app.backup("cutover");
	await app.backup("target", "manual");
	await app.backup("safety");
	await app.backup("good", "pre-flip", 4);
	await app.sql(`INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,safety_backup,generation,restored_to_seq)
		VALUES('proof','hash','session','target','rollback','safety',11,0)`);
	expect(await app.prune({ capacity: 500, required: 100 })).toMatchObject({ failure: { code: "backup_budget" } });
	for (let n = 1; n <= 11; n++) expect(await app.exists(`gen/${n}`)).toBe(true);
	for (const id of ["cutover", "target", "safety", "good"]) expect(await app.exists(`backups/${id}.db`)).toBe(true);
	await app.sql("UPDATE child_attempts SET closed=1 WHERE id='keeper'");
	await app.sql("DELETE FROM cutover");
	await app.sql("UPDATE db_restore_requests SET phase='failed'");
	expect(await app.prune({ capacity: 2000 })).toMatchObject({ success: { backup_bytes: 400 } });
	for (const n of [1, 2, 3, 11]) expect(await app.exists(`gen/${n}`)).toBe(false);
	expect(await app.sql("SELECT count(*) AS count FROM generations")).toEqual([{ count: 11 }]);
	for (const n of [1, 2, 3])
		expect(await app.sql(`SELECT snapshot_dir,status,good FROM generations WHERE n=${n}`)).toEqual([
			{ snapshot_dir: null, status: "retired", good: 1 },
		]);
	for (const n of [4, 5, 6, 7, 8, 9, 10])
		expect(await app.sql(`SELECT snapshot_dir FROM generations WHERE n=${n}`)).toEqual([
			{ snapshot_dir: `${app.root}/gen/${n}/source` },
		]);
	expect(await app.sql("SELECT receipt,closed FROM child_attempts WHERE id='keeper'")).toEqual([
		{ receipt: "receipt", closed: 1 },
	]);
});

it("keeps legacy provenance and noncanonical artifacts, refusing overflow rather than destroying evidence", async (test) => {
	const app = await store(test);
	await app.backup("legacy", "hourly", null);
	await app.generation(2);
	await app.backup("restore", "pre-restore", 2);
	await app.backup("outside");
	await app.sql(`UPDATE backups SET path='${app.root}/outside.db' WHERE id='outside'`);
	await writeFile(join(app.root, "outside.db"), "untouched");
	await app.generation(1, "failed", 0);
	await app.sql(`UPDATE generations SET snapshot_dir='${app.root}/legacy/source' WHERE n=1`);
	expect(await app.prune({ capacity: 100 })).toMatchObject({ failure: { code: "backup_budget" } });
	expect(await app.exists("gen/1")).toBe(true);
	expect(await readFile(join(app.root, "outside.db"), "utf8")).toBe("untouched");
	expect(await app.sql("SELECT count(*) AS count FROM backups")).toEqual([{ count: 3 }]);
});

it("rejects symlinked files, ancestors and dangling symlinks without deleting their targets", async (test) => {
	const app = await store(test);
	await app.backup("linked");
	await writeFile(join(app.root, "outside.db"), "untouched");
	await rm(join(app.root, "backups", "linked.db"));
	await symlink(join(app.root, "outside.db"), join(app.root, "backups", "linked.db"));
	expect(await app.prune({ capacity: 100 })).toMatchObject({ failure: { code: "unsafe_artifact_path" } });
	expect(await readFile(join(app.root, "outside.db"), "utf8")).toBe("untouched");
	await rm(join(app.root, "backups", "linked.db"));
	await symlink(join(app.root, "absent.db"), join(app.root, "backups", "linked.db"));
	expect(await app.prune({ capacity: 100 })).toMatchObject({ failure: { code: "unsafe_artifact_path" } });
	await rm(join(app.root, "backups", "linked.db"));
	await app.generation(1, "failed", 0);
	await rm(join(app.root, "gen", "1"), { recursive: true });
	await symlink(join(app.root, "backups"), join(app.root, "gen", "1"));
	expect(await app.prune()).toMatchObject({ failure: { code: "unsafe_artifact_path" } });
	expect(await app.exists("backups")).toBe(true);
});

it("reconciles interrupted unlink-before-catalog deletion on restart and retains closure history", async (test) => {
	const app = await store(test);
	await app.backup("interrupted");
	await app.sql("CREATE TRIGGER fail_prune BEFORE DELETE ON backups BEGIN SELECT RAISE(ABORT,'injected'); END");
	expect(await app.prune({ capacity: 100 })).toHaveProperty("failure");
	expect(await app.exists("backups/interrupted.db")).toBe(false);
	expect(await app.sql("SELECT id FROM backups")).toEqual([{ id: "interrupted" }]);
	await app.sql("DROP TRIGGER fail_prune");
	expect(await app.prune({ capacity: 100 })).toMatchObject({ success: { backup_bytes: 0 } });
	expect(await app.sql("SELECT id FROM backups")).toEqual([]);
});

it("declines unknown capacity for new copies but can prune failed snapshots without it", async (test) => {
	const app = await store(test);
	await app.generation(1, "failed", 0, true);
	await app.backup("retained");
	const catalog = await app.sql("SELECT * FROM backups");
	expect(await app.prune({ required: 1 })).toMatchObject({
		failure: { _tag: "StorageRejected", code: "storage_measurement_failed" },
	});
	expect(await app.exists("gen/1")).toBe(true);
	expect(await readFile(join(app.root, "backups/retained.db"), "utf8")).toBe("retained-data");
	expect(await app.sql("SELECT * FROM backups")).toEqual(catalog);
	expect(await app.prune({ capacity: 1000, required: 1 })).toMatchObject({ success: { backup_bytes: 100 } });
	await app.generation(2, "failed", 0, true);
	expect(await app.prune({})).toMatchObject({ success: { backup_limit_bytes: null, removed_generations: 1 } });
	expect(await app.exists("gen/1")).toBe(false);
});

it("syncs missing-file reconciliation before forgetting a failed unlink sync", async (test) => {
	const app = await store(test);
	await app.backup("uncertain-sync");
	await expect(app.prune({ capacity: 100, fail_sync: true })).rejects.toThrow();
	expect(await app.exists("backups/uncertain-sync.db")).toBe(false);
	expect(await app.sql("SELECT id FROM backups")).toEqual([{ id: "uncertain-sync" }]);
	expect(await app.prune({ capacity: 100 })).toMatchObject({ success: { backup_bytes: 0 }, directory_syncs: 1 });
	expect(await app.sql("SELECT id FROM backups")).toEqual([]);
});

it("prunes completed restore safety copies after their generation ages out, retaining the receipt", async (test) => {
	const app = await store(test);
	for (let n = 1; n <= 6; n++) await app.generation(n);
	await app.backup("target", "hourly", 1);
	await app.backup("safety", "pre-restore", 1);
	await app.backup("retained-safety", "pre-restore", 6);
	await app.sql(`INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,safety_backup,generation,restored_to_seq)
		VALUES('proof','hash','session','target','restored','safety',1,0)`);
	expect(await app.prune({ capacity: 500 })).toMatchObject({ success: { backup_bytes: 100, removed_backups: 2 } });
	expect(await app.exists("backups/safety.db")).toBe(false);
	expect(await app.exists("backups/retained-safety.db")).toBe(true);
	expect(await app.sql("SELECT phase,backup,safety_backup FROM db_restore_requests")).toEqual([
		{ phase: "restored", backup: "target", safety_backup: "safety" },
	]);
});

it("retains snapshot links across an interrupted removal sync and clears them after durable retry", async (test) => {
	const app = await store(test);
	await app.generation(1, "failed", 0);
	await expect(app.prune({ fail_generation_sync: true })).rejects.toThrow();
	expect(await app.exists("gen/1")).toBe(false);
	expect(await app.sql("SELECT snapshot_dir,status,good FROM generations WHERE n=1")).toEqual([
		{ snapshot_dir: `${app.root}/gen/1/source`, status: "failed", good: 0 },
	]);
	expect(await app.prune({})).toMatchObject({ success: { removed_generations: 0 } });
	expect(await app.sql("SELECT snapshot_dir,status,good FROM generations WHERE n=1")).toEqual([
		{ snapshot_dir: null, status: "failed", good: 0 },
	]);
});

it("prunes stale live history after keeper closure while retaining the actual live owner's snapshot", async (test) => {
	const app = await store(test);
	for (let n = 1; n <= 8; n++) {
		await app.generation(n, "live");
		await app.sql(`INSERT INTO child_attempts(id,generation,receipt,opened,closed)
			VALUES('attempt-${n}',${n},'receipt-${n}',1,${n === 1 ? 0 : 1})`);
	}
	expect(await app.prune()).toMatchObject({ success: { removed_generations: 2 } });
	for (const n of [2, 3]) {
		expect(await app.exists(`gen/${n}`)).toBe(false);
		expect(await app.sql(`SELECT status,good,snapshot_dir FROM generations WHERE n=${n}`)).toEqual([
			{ status: "live", good: 1, snapshot_dir: null },
		]);
	}
	for (const n of [1, 4, 5, 6, 7, 8]) expect(await app.exists(`gen/${n}`)).toBe(true);
	expect(await app.sql("SELECT receipt,closed FROM child_attempts WHERE generation=1")).toEqual([
		{ receipt: "receipt-1", closed: 0 },
	]);
});

it("prunes checked generations with stale starting labels after their rehearsal keeper closes", async (test) => {
	const app = await store(test);
	await app.generation(1, "starting", 0);
	await app.sql("INSERT INTO child_attempts(id,generation,receipt,opened,closed) VALUES('checked',1,'receipt',0,1)");
	expect(await app.prune()).toMatchObject({ success: { removed_generations: 1 } });
	expect(await app.exists("gen/1")).toBe(false);
	expect(await app.sql("SELECT snapshot_dir,status,good FROM generations WHERE n=1")).toEqual([
		{ snapshot_dir: null, status: "starting", good: 0 },
	]);
});

it("bounds repeated manual copies after hourly eviction without pinning them to a retained generation", async (test) => {
	const app = await store(test);
	await app.generation(1);
	await app.backup("old-pre-flip", "pre-flip", 99, 0);
	await app.backup("manual-old", "manual", 1, 1);
	await app.backup("manual-new", "manual", 1, 2);
	await app.backup("hourly-newest", "hourly", 1, 99);
	expect(await app.prune()).toMatchObject({ success: { backup_bytes: 200, removed_backups: 2 } });
	expect(await app.exists("backups/hourly-newest.db")).toBe(false);
	expect(await app.exists("backups/manual-old.db")).toBe(false);
	expect(await app.exists("backups/manual-new.db")).toBe(true);
	expect(await app.exists("backups/old-pre-flip.db")).toBe(true);
	await app.backup("manual-latest", "manual", 1, 3);
	expect(await app.prune()).toMatchObject({ success: { backup_bytes: 200, removed_backups: 1 } });
	expect(await app.exists("backups/manual-new.db")).toBe(false);
	expect(await app.exists("backups/manual-latest.db")).toBe(true);
	expect(await app.exists("backups/old-pre-flip.db")).toBe(true);
});

it("keeps a closed old fallback for the operation that must restart it, then prunes after release", async (test) => {
	const app = await store(test);
	for (let n = 1; n <= 6; n++) await app.generation(n);
	await app.sql("INSERT INTO child_attempts(id,generation,receipt,opened,closed) VALUES('fallback',1,'receipt',1,1)");
	await app.backup("fallback-pre-flip", "pre-flip", 1);
	expect(await app.prune({ capacity: 100, preserve: [1] })).toMatchObject({ failure: { code: "backup_budget" } });
	expect(await app.exists("gen/1")).toBe(true);
	expect(await app.exists("backups/fallback-pre-flip.db")).toBe(true);
	expect(await app.sql("SELECT snapshot_dir FROM generations WHERE n=1")).toEqual([
		{ snapshot_dir: `${app.root}/gen/1/source` },
	]);
	expect(await app.prune({ capacity: 100, preserve: [] })).toMatchObject({
		success: { removed_generations: 1, removed_backups: 1 },
	});
	expect(await app.exists("gen/1")).toBe(false);
	expect(await app.exists("backups/fallback-pre-flip.db")).toBe(false);
});

it("retains combined restore source and fallback plus exact backup links from protected generations", async (test) => {
	const app = await store(test);
	for (let n = 1; n <= 9; n++) await app.generation(n);
	await app.backup("source-copy", "pre-flip", 99);
	await app.backup("fallback-copy", "pre-flip", 98);
	await app.backup("operation-copy", "pre-flip", 97);
	await app.backup("newest-copy", "pre-flip", 96);
	await app.backup("target", "hourly", 95);
	await app.sql("UPDATE generations SET backup_id='source-copy' WHERE n=1");
	await app.sql("UPDATE generations SET backup_id='fallback-copy' WHERE n=2");
	await app.sql("UPDATE generations SET backup_id='operation-copy' WHERE n=3");
	await app.sql("UPDATE generations SET backup_id='newest-copy' WHERE n=9");
	await app.sql(`INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,generation,source_generation,prior_generation,restored_to_seq)
 VALUES('proof','hash','session','target','working',8,1,2,0)`);
	expect(await app.prune({ capacity: 100, preserve: [3] })).toMatchObject({ failure: { code: "backup_budget" } });
	for (const n of [1, 2, 3, 8, 9]) expect(await app.exists(`gen/${n}`)).toBe(true);
	for (const id of ["source-copy", "fallback-copy", "operation-copy", "newest-copy", "target"])
		expect(await app.exists(`backups/${id}.db`)).toBe(true);
	await app.sql("UPDATE db_restore_requests SET phase='restored'");
	expect(await app.prune({ capacity: 500 })).toMatchObject({ success: { removed_backups: 4 } });
	expect(await app.exists("backups/newest-copy.db")).toBe(true);
});

it("reads changed backup percentages on every pass without evicting recovery evidence", async (test) => {
	const app = await store(test);
	await app.backup("one");
	await app.backup("two");
	await app.sql(
		`INSERT INTO settings VALUES('storage_policy','{"backup_percent":30,"event_percent":10,"headroom_percent":5}')`,
	);
	expect(await app.prune({ capacity: 1000, required: 100 })).toMatchObject({
		success: { backup_limit_bytes: 300, removed_backups: 0 },
	});
	await app.sql(
		`UPDATE settings SET value='{"backup_percent":10,"event_percent":10,"headroom_percent":5}' WHERE key='storage_policy'`,
	);
	expect(await app.prune({ capacity: 1000 })).toMatchObject({
		success: { backup_limit_bytes: 100, removed_backups: 1 },
	});
	await app.sql("INSERT INTO cutover VALUES(1,1,2,'two','lock','family','frozen',NULL)");
	expect(await app.prune({ capacity: 500 })).toMatchObject({ failure: { code: "backup_budget" } });
	expect(await app.exists("backups/two.db")).toBe(true);
});

it("keeps invalid copy sizes, capacity and persisted backup sizes distinct from a failed probe", async (test) => {
	const app = await store(test);
	await app.backup("invalid");
	const invalid = { failure: { _tag: "ArtifactRetentionRejected", code: "invalid_storage_sample" } };
	expect(await app.prune({ required: -1 })).toMatchObject(invalid);
	expect(await app.prune({ capacity: 0, required: 1 })).toMatchObject(invalid);
	await app.sql("UPDATE backups SET bytes=-1 WHERE id='invalid'");
	expect(await app.prune({ capacity: 1000, required: 1 })).toMatchObject(invalid);
	expect(await readFile(join(app.root, "backups/invalid.db"), "utf8")).toBe("retained-data");
	expect(await app.sql("SELECT bytes FROM backups WHERE id='invalid'")).toEqual([{ bytes: -1 }]);
});
