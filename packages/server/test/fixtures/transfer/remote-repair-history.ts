import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { memoryStoreLayer } from "../test-store.ts";
import { Console, Context, Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { withDatabase, type RemoteStore } from "@comms/storage/store";
import { TransferRejected, type TransferSelection } from "@comms/storage/store-transfer-schema";
import { initializeBootSchema } from "../../../../boot/src/boot-schema.ts";
import { remoteRecovery } from "../../../../boot/src/app-recovery.ts";
import { remoteAppStoreIdentity } from "../../../../boot/src/app-store-identity.ts";
import { layer as eventsLayer } from "../../../../boot/src/events.ts";
import { remoteRestoreSelection } from "../../../../boot/src/remote-restore-selection.ts";
import { assertTransferSourceRepair } from "../../../src/transfer/source-session.ts";
import { inspectTransferSource } from "../../../src/transfer/source-preflight.ts";
import { prepareControlSettings } from "../../../src/transfer/control-settings.ts";

const main = Effect.gen(function* () {
	const source = yield* SqlClient.SqlClient;
	const open = Effect.gen(function* () {
		return Context.get(yield* Layer.build(memoryStoreLayer()), SqlClient.SqlClient);
	});
	const app = yield* open;
	const target = yield* open;
	yield* initializeBootSchema;
	yield* initializeBootSchema.pipe(Effect.provideService(SqlClient.SqlClient, target));
	const sourceStore: RemoteStore = {
		_tag: "postgres",
		database: "original",
		url: Redacted.make("postgres://app:fixture@example.test/original"),
	};
	const targetStore: RemoteStore = {
		_tag: "mysql",
		database: "transferred",
		url: Redacted.make("mysql://app:fixture@destination.test/transferred"),
	};
	const recovery = (sql: SqlClient.SqlClient, store: RemoteStore) =>
		remoteRecovery({
			appStore: store,
			bootStore: store,
			dataDirectory: "/data",
			authorizeStoreAccess: () => Effect.die("Metadata check must not authorize a remote store"),
			withStore: () => Effect.die("Metadata check must not open a remote store"),
			initialize: () => Effect.die("Metadata check must not initialize a remote store"),
		}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
	const identity = yield* remoteAppStoreIdentity(sourceStore);
	const adoption = yield* identity.reserve;
	yield* identity.complete(adoption);
	const before = yield* remoteRestoreSelection(yield* recovery(source, sourceStore));
	yield* app`CREATE TABLE store_identity(singleton INTEGER,store_id TEXT,initialized_at INTEGER,transferred_to TEXT)`;
	yield* app`INSERT INTO store_identity VALUES(1,${adoption.store_id},${adoption.initialized_at},NULL)`;
	yield* app`CREATE TABLE kernel_writer(singleton INTEGER,epoch TEXT)`;
	yield* app`INSERT INTO kernel_writer VALUES(1,${"e".repeat(64)})`;
	yield* app`CREATE TABLE outbox(seq INTEGER,shipped_at INTEGER)`;
	yield* app`CREATE TABLE topic_page_continuations(completed INTEGER)`;
	yield* source`INSERT INTO generations(n,snapshot_dir,entry_file,status,good,started_at) VALUES(1,'/data/snapshots/1','server.ts','retired',1,0)`;
	const failedProof = "F".repeat(43);
	const restoredProof = "S".repeat(43);
	const start = (proof: string) =>
		source.withTransaction(
			Effect.gen(function* () {
				yield* source`INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,restored_to_seq) VALUES(${proof},'hash','session','backup','restoring',0)`;
				yield* before.record(proof);
			}),
		);
	yield* start(failedProof);
	yield* source`UPDATE db_restore_requests SET phase='failed' WHERE proof_id=${failedProof}`;
	assert.equal(yield* before.blocksStartup, true);
	let appOpened = false;
	const failedCurrent = yield* assertTransferSourceRepair(source, sourceStore, adoption.store_id).pipe(
		Effect.andThen(
			Effect.sync(() => {
				appOpened = true;
			}),
		),
		Effect.result,
	);
	assert.equal(appOpened, false);
	assert.equal(failedCurrent._tag, "Failure");
	if (failedCurrent._tag === "Failure") {
		assert.equal(Schema.is(TransferRejected)(failedCurrent.failure), true);
		if (Schema.is(TransferRejected)(failedCurrent.failure))
			assert.equal(failedCurrent.failure.code, "transfer_recovery_pending");
	}

	yield* start(restoredProof);
	const pending = yield* inspectTransferSource(source, app, sourceStore, "/data").pipe(Effect.result);
	assert.equal(pending._tag, "Failure");
	if (pending._tag === "Failure") {
		assert.equal(Schema.is(TransferRejected)(pending.failure), true);
		if (Schema.is(TransferRejected)(pending.failure)) assert.equal(pending.failure.code, "transfer_recovery_pending");
	}
	const repaired = yield* withDatabase(sourceStore, "repaired");
	yield* source.withTransaction(
		Effect.gen(function* () {
			yield* identity.selectRestored(repaired);
			yield* source`UPDATE db_restore_requests SET phase='restored' WHERE proof_id=${restoredProof}`;
		}),
	);
	assert.equal(yield* before.blocksStartup, false);
	yield* assertTransferSourceRepair(source, repaired, adoption.store_id);
	yield* inspectTransferSource(source, app, repaired, "/data");
	const selection: TransferSelection = {
		version: 1,
		transfer_id: "12345678-1234-4123-8123-123456789abc",
		store_id: adoption.store_id,
		data_directory: "/data",
		source: { engine: "pg", endpoint: "example.test:5432", boot: "boot", app: "repaired" },
		target: { engine: "mysql", endpoint: "destination.test:3306", boot: "target_boot", app: "transferred" },
	};
	const retained = yield* source<{
		key: string;
		value: string;
	}>`SELECT key,value FROM settings WHERE key LIKE 'restore-remote-before:%' ORDER BY key`;
	assert.equal(retained.length, 2);
	assert.ok(retained.every((row) => `transfer-history:${selection.transfer_id}:${row.key}`.length === 119));
	yield* target`INSERT INTO settings VALUES('transfer_state','in_progress')`;
	const projected = yield* prepareControlSettings(source, target, selection, adoption.initialized_at);
	yield* projected.copy;
	yield* projected.verify;
	// Ordinary transfer copies the terminal request history separately from settings.
	for (const [proof, phase] of [
		[failedProof, "failed"],
		[restoredProof, "restored"],
	] as const) {
		yield* target`INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,restored_to_seq) VALUES(${proof},'hash','session','backup',${phase},0)`;
	}
	yield* target`UPDATE settings SET value='complete' WHERE key='transfer_state'`;
	for (const row of retained) {
		const archived = yield* target<{
			value: string;
		}>`SELECT value FROM settings WHERE key=${`transfer-history:${selection.transfer_id}:${row.key}`}`;
		assert.equal(archived[0]?.value, row.value);
	}
	assert.equal((yield* target`SELECT key FROM settings WHERE key LIKE 'restore-remote-before:%'`).length, 0);
	const destination = yield* remoteRestoreSelection(yield* recovery(target, targetStore)).pipe(
		Effect.provideService(SqlClient.SqlClient, target),
	);
	assert.equal(yield* destination.blocksStartup, false);
	assert.equal(yield* destination.read(failedProof), null);
	return { passed: true };
}).pipe(
	Effect.provide(eventsLayer(Effect.void)),
	Effect.provide(memoryStoreLayer()),
	Effect.scoped,
	Effect.provide(BunServices.layer),
);
main.pipe(
	Effect.flatMap((result) => Console.log(JSON.stringify(result))),
	BunRuntime.runMain,
);
