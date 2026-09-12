import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { readTransferSource, ensureSourceSafety } from "../../../src/transfer/source-session.ts";
import type { TransferSelection } from "@comms/storage/store-transfer-schema";

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const directory = yield* fs.makeTempDirectoryScoped().pipe(Effect.flatMap(fs.realPath));
	const filename = `${directory}/comms.db`;
	const bootfile = `${directory}/boot.db`;
	const id = "12345678-1234-4234-8234-123456789abc";
	yield* Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE boot_migrations(migration_id INTEGER PRIMARY KEY,name TEXT)`;
			for (let n = 1; n <= 20; n++)
				yield* sql`INSERT INTO boot_migrations VALUES(${n},${n === 20 ? "offline_store_transfer" : `migration-${n}`})`;
			yield* sql`PRAGMA user_version=20`;
			yield* sql`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)`;
			const adoption = { store_id: id, initialized_at: 123, phase: "ready", filename, mode: "fresh" };
			const set = (key: string, value: string) =>
				sql`INSERT INTO settings VALUES(${key},${value}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
			yield* set("app_store_adoption", JSON.stringify(adoption));
			yield* set("app_store_id", id);
			yield* set("app_store_initialized", "1");
			yield* sql`CREATE TABLE store_identity(singleton INTEGER,store_id TEXT,initialized_at INTEGER,transferred_to TEXT)`;
			yield* sql`INSERT INTO store_identity VALUES(1,${id},123,NULL)`;
			yield* sql`CREATE TABLE kernel_writer(singleton INTEGER,epoch TEXT)`;
			yield* sql`INSERT INTO kernel_writer VALUES(1,'prior-epoch')`;
			yield* sql`CREATE TABLE seq(singleton INTEGER,next INTEGER,published_through INTEGER,pending_id TEXT,pending_attempt TEXT,pending_from INTEGER,pending_to INTEGER)`;
			yield* sql`INSERT INTO seq VALUES(1,8,7,NULL,NULL,NULL,NULL)`;
			for (const ddl of [
				"CREATE TABLE cutover(singleton INTEGER)",
				"CREATE TABLE db_restore_requests(phase TEXT,lock_id TEXT)",
				"CREATE TABLE source_batches(state TEXT)",
				"CREATE TABLE source_changes(batch TEXT)",
				"CREATE TABLE edit_lock(id TEXT)",
				"CREATE TABLE staging(path TEXT)",
				"CREATE TABLE child_attempts(id TEXT PRIMARY KEY,receipt TEXT,closed INTEGER)",
				"CREATE TABLE event_batches(state TEXT)",
				"CREATE TABLE outbox(seq INTEGER,shipped_at INTEGER)",
				"CREATE TABLE topic_page_continuations(completed INTEGER)",
				"CREATE TABLE generations(n INTEGER,entry_file TEXT,snapshot_dir TEXT,good INTEGER)",
			])
				yield* sql.unsafe(ddl);
			yield* sql`INSERT INTO generations VALUES(3,'server.ts','/data/snapshots/3',1),(4,'broken.ts',NULL,0)`;
		}).pipe(Effect.provide(SqliteClient.layer({ filename: bootfile, disableWAL: true }))),
	);
	yield* fs.copyFile(bootfile, filename);
	const configuration = {
		_tag: "file",
		boot: { _tag: "file", filename: bootfile },
		app: { _tag: "file", filename },
	} as const;
	const wal = process.argv[2] === "wal";
	if (wal) {
		yield* Effect.tryPromise({
			try: () =>
				new Promise<void>((resolve, reject) => {
					const child = spawn("bun", [`${import.meta.dirname}/source-session-wal-writer.ts`, bootfile, filename], {
						stdio: ["ignore", "pipe", "pipe"],
					});
					let ready = false;
					let timedOut = false;
					let output = "";
					const timer = setTimeout(() => {
						timedOut = true;
						child.kill("SIGKILL");
					}, 10000);
					child.stdout.on("data", (chunk) => {
						output += String(chunk);
						if (output.includes("ready")) {
							ready = true;
							child.kill("SIGKILL");
						}
					});
					child.once("error", (error) => {
						clearTimeout(timer);
						reject(error);
					});
					child.once("exit", () => {
						clearTimeout(timer);
						if (ready && !timedOut) resolve();
						else reject(new Error("WAL writer exited before commit"));
					});
				}),
			catch: () => new Error("WAL writer failed"),
		});
	}
	const priorWal: Array<{ filename: string; bytes: Uint8Array }> = [];
	if (wal)
		for (const source of [bootfile, filename])
			priorWal.push({ filename: `${source}-wal`, bytes: yield* fs.readFile(`${source}-wal`) });
	const originalBoot = yield* fs.readFile(bootfile);
	const originalApp = yield* fs.readFile(filename);
	const sourceEvidence = yield* readTransferSource({ configuration, owner: null, dataDirectory: directory });
	assert.equal(sourceEvidence.proof.store_id, id);
	assert.deepEqual(yield* fs.readFile(bootfile), originalBoot);
	assert.deepEqual(yield* fs.readFile(filename), originalApp);
	for (const item of priorWal) assert.deepEqual(yield* fs.readFile(item.filename), item.bytes);
	const beforeBoot = yield* fs.readFile(bootfile);
	const beforeApp = yield* fs.readFile(filename);
	const selection: TransferSelection = {
		version: 1,
		transfer_id: "23456789-1234-4234-8234-123456789abc",
		store_id: id,
		data_directory: directory,
		source: { engine: "sqlite", endpoint: null, boot: bootfile, app: filename },
		target: { engine: "pg", endpoint: "example.test:5432", boot: "boot", app: "app" },
	};
	const options = { configuration, owner: null, selection, sourceEvidence };
	const partial = `${directory}/transfers/${selection.transfer_id}/safety/34567890-1234-4234-8234-123456789abc`;
	yield* fs.makeDirectory(partial, { recursive: true, mode: 0o700 });
	yield* fs.writeFileString(`${partial}/boot.db`, "interrupted");
	assert.equal((yield* ensureSourceSafety({ ...options, requireExisting: true }).pipe(Effect.result))._tag, "Failure");
	const receipt = yield* ensureSourceSafety({ ...options, requireExisting: false });
	assert.equal(yield* ensureSourceSafety({ ...options, requireExisting: true }), receipt);
	assert.equal(yield* fs.readFileString(`${partial}/boot.db`), "interrupted");
	assert.deepEqual(yield* fs.readFile(bootfile), beforeBoot);
	assert.deepEqual(yield* fs.readFile(filename), beforeApp);
	for (const item of priorWal) assert.deepEqual(yield* fs.readFile(item.filename), item.bytes);
	const malformed = `${directory}/transfers/${selection.transfer_id}/safety/45678901-1234-4234-8234-123456789abc`;
	yield* fs.makeDirectory(malformed, { mode: 0o700 });
	yield* fs.writeFileString(`${malformed}/receipt.json`, "broken");
	assert.equal((yield* ensureSourceSafety({ ...options, requireExisting: false }).pipe(Effect.result))._tag, "Failure");
	yield* fs.remove(`${malformed}/receipt.json`);
	const artifact = `${receipt.slice(0, receipt.lastIndexOf("/"))}/app.db`;
	yield* fs.writeFileString(artifact, "corrupted");
	assert.equal((yield* ensureSourceSafety({ ...options, requireExisting: true }).pipe(Effect.result))._tag, "Failure");
	// A new capture must recheck closed child evidence rather than trust old preflight evidence.
	yield* Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO child_attempts VALUES('pending',${`${directory}/attempts/pending.closed`},0)`;
		}).pipe(Effect.provide(SqliteClient.layer({ filename: bootfile, disableWAL: true }))),
	);
	const fresh = { ...options, selection: { ...selection, transfer_id: "56789012-1234-4234-8234-123456789abc" } };
	assert.equal((yield* ensureSourceSafety({ ...fresh, requireExisting: false }).pipe(Effect.result))._tag, "Failure");
	assert.equal(
		(yield* readTransferSource({ configuration, owner: null, dataDirectory: directory }).pipe(Effect.result))._tag,
		"Failure",
	);
	return { passed: true };
}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(FetchHttpClient.layer));
main.pipe(
	Effect.flatMap((value) => Console.log(JSON.stringify(value))),
	BunRuntime.runMain,
);
