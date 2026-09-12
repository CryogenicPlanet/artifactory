import assert from "node:assert/strict";
import { BunRuntime } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { transferStores } from "../../src/store-transfer-coordinator.ts";
import type { TransferBinding } from "@comms/storage/store-transfer-schema";

const directory = process.argv[2];
const mode = process.argv[3];
assert.ok(directory && mode);
const main = Effect.gen(function* () {
	const sourceBoot = yield* SqliteClient.make({ filename: `${directory}/source-boot.db` });
	const sourceApp = yield* SqliteClient.make({ filename: `${directory}/source-app.db` });
	const targetBoot = yield* SqliteClient.make({ filename: `${directory}/target-boot.db` });
	const targetApp = yield* SqliteClient.make({ filename: `${directory}/target-app.db` });
	const binding: TransferBinding = {
		version: 1,
		transfer_id: "22222222-2222-4222-8222-222222222222",
		store_id: "11111111-1111-4111-8111-111111111111",
		data_directory: directory,
		source: {
			engine: "sqlite",
			endpoint: null,
			boot: `${directory}/source-boot.db`,
			app: `${directory}/source-app.db`,
		},
		target: {
			engine: "sqlite",
			endpoint: null,
			boot: `${directory}/target-boot.db`,
			app: `${directory}/target-app.db`,
		},
		manifest: "a".repeat(64),
	};
	for (const sql of [sourceBoot, targetBoot]) {
		yield* sql`CREATE TABLE boot_migrations(migration_id INTEGER PRIMARY KEY,name TEXT)`;
		yield* sql`INSERT INTO boot_migrations VALUES(20,'offline_store_transfer')`;
		yield* sql`PRAGMA user_version=20`;
		yield* sql`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)`;
		yield* sql`CREATE TABLE seq(singleton INTEGER PRIMARY KEY,pending_id TEXT)`;
		yield* sql`INSERT INTO seq VALUES(1,NULL)`;
		yield* sql`CREATE TABLE cutover(id INTEGER)`;
		yield* sql`CREATE TABLE db_restore_requests(phase TEXT,lock_id TEXT)`;
		yield* sql`CREATE TABLE source_batches(state TEXT)`;
		yield* sql`INSERT INTO settings VALUES('app_store_id',${binding.store_id})`;
	}
	for (const sql of [sourceApp, targetApp]) {
		yield* sql`CREATE TABLE store_identity(singleton INTEGER PRIMARY KEY,store_id TEXT,transferred_to TEXT)`;
		yield* sql`INSERT INTO store_identity VALUES(1,${binding.store_id},NULL)`;
		yield* sql`CREATE TABLE messages(id INTEGER PRIMARY KEY,body TEXT)`;
	}
	yield* sourceApp`INSERT INTO messages VALUES(1,'retained')`;
	yield* targetBoot`INSERT INTO settings VALUES('transfer_state','in_progress')`;
	let copies = 0;
	let verifies = 0;
	const options = {
		sourceBoot,
		sourceApp,
		targetBoot,
		targetApp,
		assertExclusive: Effect.void,
		copyAndVerify: Effect.gen(function* () {
			copies++;
			yield* targetApp`INSERT INTO messages VALUES(1,'retained')`;
			if (mode === "controls") yield* targetBoot`DELETE FROM settings WHERE key='transfer_journal'`;
			return binding.manifest;
		}),
		reverify: Effect.sync(() => {
			verifies++;
			return binding.manifest;
		}),
	};
	const run = transferStores(binding, options);
	if (mode.endsWith("-ledger19") || mode.endsWith("-mirror19")) {
		const sql = mode.startsWith("source-") ? sourceBoot : targetBoot;
		if (mode.endsWith("-ledger19")) yield* sql`DELETE FROM boot_migrations WHERE migration_id=20`;
		else yield* sql`PRAGMA user_version=19`;
		assert.equal((yield* run.pipe(Effect.result))._tag, "Failure");
		assert.equal(copies, 0);
		assert.deepEqual(yield* sourceBoot`SELECT value FROM settings WHERE key='transferred_to'`, []);
		assert.deepEqual(yield* targetBoot`SELECT value FROM settings WHERE key='transfer_journal'`, []);
	} else if (mode === "pending") {
		yield* sourceBoot`UPDATE seq SET pending_id='uncertain'`;
		assert.equal((yield* run.pipe(Effect.result))._tag, "Failure");
		assert.equal(copies, 0);
		yield* sourceBoot`UPDATE seq SET pending_id=NULL`;
		yield* sourceBoot`INSERT INTO db_restore_requests VALUES('restored','unfinished-cleanup')`;
		assert.equal((yield* run.pipe(Effect.result))._tag, "Failure");
		assert.equal(copies, 0);
	} else if (mode === "nested") {
		assert.equal((yield* sourceBoot.withTransaction(run).pipe(Effect.result))._tag, "Failure");
		assert.equal(copies, 0);
	} else if (mode === "controls") {
		assert.equal((yield* run.pipe(Effect.result))._tag, "Failure");
		assert.deepEqual(yield* sourceBoot`SELECT value FROM settings WHERE key='transferred_to'`, []);
	} else if (mode === "conflict") {
		yield* sourceBoot`INSERT INTO settings VALUES('transferred_to','unrelated-transfer')`;
		assert.equal((yield* run.pipe(Effect.result))._tag, "Failure");
		assert.equal(copies, 0);
	} else {
		if (mode === "boot-gap" || mode === "app-gap") {
			const phase = mode === "boot-gap" ? "source_boot_retired" : "source_app_retired";
			yield* targetBoot.unsafe(
				`CREATE TRIGGER fail_phase BEFORE UPDATE ON settings WHEN NEW.key='transfer_journal' AND NEW.value LIKE '%"phase":"${phase}"%' BEGIN SELECT RAISE(ABORT,'injected phase failure'); END`,
			);
			assert.equal((yield* run.pipe(Effect.result))._tag, "Failure");
			assert.equal((yield* targetBoot`SELECT value FROM settings WHERE key='transfer_state'`)[0]?.value, "in_progress");
			assert.equal((yield* sourceBoot`SELECT value FROM settings WHERE key='transferred_to'`).length, 1);
			yield* targetBoot`DROP TRIGGER fail_phase`;
		}
		assert.equal((yield* run).phase, "complete");
		assert.equal(copies, 1);
		assert.deepEqual(yield* targetApp`SELECT * FROM messages`, [{ id: 1, body: "retained" }]);
		const priorVerifies = verifies;
		yield* targetBoot`INSERT INTO boot_migrations VALUES(21,'future_protocol')`;
		yield* targetBoot`PRAGMA user_version=21`;
		yield* targetApp`INSERT INTO messages VALUES(2,'legitimate post-transfer write')`;
		assert.equal((yield* run).phase, "complete");
		assert.equal(verifies, priorVerifies);
		yield* targetApp`UPDATE store_identity SET store_id='replacement'`;
		assert.equal((yield* run.pipe(Effect.result))._tag, "Failure");
	}
	return `Verified ${mode}`;
}).pipe(Effect.scoped, Effect.provide(Reactivity.layer));
BunRuntime.runMain(main.pipe(Effect.flatMap(Console.log)));
