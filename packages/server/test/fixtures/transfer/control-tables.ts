import { BunCrypto } from "@effect/platform-bun";
import { clientLayer } from "@comms/storage/client";
import type { TransferSelection } from "@comms/storage/store-transfer-schema";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { prepareControlTransfer } from "../../../src/transfer/control-tables.ts";

const root = process.argv[2];
const mode = process.argv[3];
if (!root) throw new Error("Missing fixture root");
await Effect.runPromise(
	Effect.gen(function* () {
		const open = (filename: string) =>
			Layer.build(clientLayer({ _tag: "file", filename })).pipe(
				Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
			);
		const sourceBoot = yield* open(`${root}/source-boot.db`);
		const sourceApp = yield* open(`${root}/source-app.db`);
		const targetBoot = yield* open(`${root}/target-boot.db`);
		const targetApp = yield* open(`${root}/store/comms.db`);
		const id = "12345678-1234-4123-8123-123456789abc";
		const transferId = "98765432-1234-4123-8123-123456789abc";
		const epoch = "a".repeat(64);
		const selection: TransferSelection = {
			version: 1,
			transfer_id: transferId,
			data_directory: root,
			source: { engine: "sqlite", endpoint: null, boot: `${root}/source-boot.db`, app: `${root}/source-app.db` },
			target: { engine: "sqlite", endpoint: null, boot: `${root}/target-boot.db`, app: `${root}/store/comms.db` },
			store_id: id,
		};
		for (const boot of [sourceBoot, targetBoot]) {
			yield* boot`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)`;
			yield* boot`CREATE TABLE seq(singleton INTEGER PRIMARY KEY,next INTEGER NOT NULL,published_through INTEGER NOT NULL,pending_id TEXT,pending_attempt TEXT,pending_from INTEGER,pending_to INTEGER)`;
			yield* boot`INSERT INTO seq VALUES(1,1,0,NULL,NULL,NULL,NULL)`;
		}
		yield* sourceBoot`UPDATE seq SET next=91,published_through=90`;
		for (const app of [sourceApp, targetApp]) {
			yield* app`CREATE TABLE store_identity(singleton INTEGER PRIMARY KEY,store_id TEXT,initialized_at INTEGER,transferred_to TEXT)`;
			yield* app`INSERT INTO store_identity VALUES(1,${id},123,NULL)`;
			yield* app`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT NOT NULL)`;
			yield* app`INSERT INTO kernel_writer VALUES(1,${app === targetApp ? epoch : "b".repeat(64)})`;
		}
		const ordinary = '  日本語😀\n{ "bytes" : "unchanged" }  ';
		yield* sourceBoot`INSERT INTO settings VALUES('app_seeded','1'),('pages_seeded','1'),('source.watcher_baseline',${ordinary}),('receipt:example',${ordinary}),('app_store_id',${id}),('app_store_initialized','1'),('app_store_layout','ready'),('transfer_state','complete'),('transfer_journal','old journal bytes')`;
		yield* sourceBoot`INSERT INTO settings VALUES('app_store_adoption',${JSON.stringify({ store_id: id, initialized_at: 123, filename: selection.source.app, mode: "fresh", phase: "ready" })})`;
		yield* sourceBoot`INSERT INTO settings VALUES('remote_database:old',${JSON.stringify({ id: "old", phase: "closed", database: "old_destination" })})`;
		yield* targetBoot`INSERT INTO settings VALUES('transfer_state','in_progress'),('transfer_journal','current journal bytes'),('transfer_prepare','current preparation'),('transfer_kernel','current kernel'),('app_store_schema','target schema bytes')`;
		if (mode === "publication-gap") yield* sourceBoot`UPDATE seq SET published_through=87`;
		if (mode === "malformed-receipt")
			yield* sourceBoot`INSERT INTO settings VALUES('source-revert-result:x','{"outcome":false}')`;
		if (mode === "pending") yield* sourceBoot`UPDATE seq SET pending_id='pending'`;
		if (mode === "source-progress") yield* sourceBoot`UPDATE settings SET value='moving' WHERE key='app_store_layout'`;
		if (mode === "remote-progress")
			yield* sourceBoot`UPDATE settings SET value='{"phase":"ready"}' WHERE key='remote_database:old'`;
		if (mode === "receipt-progress")
			yield* sourceBoot`INSERT INTO settings VALUES('source-revert-result:x','{"outcome":null}')`;
		if (mode === "wrong-identity") yield* targetApp`UPDATE store_identity SET initialized_at=124`;
		if (mode === "conflict") yield* targetBoot`INSERT INTO settings VALUES('receipt:example','newer target bytes')`;
		const result = yield* Effect.gen(function* () {
			const options = { sourceBoot, sourceApp, targetBoot, targetApp, selection, initializedAt: 123, epoch };
			const prepared = yield* prepareControlTransfer(options);
			yield* prepared.copySequence;
			yield* prepared.copyRemaining;
			yield* prepared.verify;
			// Source retirement is coordinator-owned and excluded from the stable data commitment.
			yield* sourceBoot`INSERT INTO settings VALUES('transferred_to','bound retirement marker')`;
			yield* sourceApp`UPDATE store_identity SET transferred_to='bound retirement marker'`;
			const resumed = yield* prepareControlTransfer(options);
			yield* resumed.copySequence;
			yield* resumed.copyRemaining;
			yield* resumed.verify;
			const unchanged = JSON.stringify(prepared.manifest) === JSON.stringify(resumed.manifest);
			yield* targetBoot`UPDATE settings SET value='corrupt' WHERE key='receipt:example'`;
			const corruption = yield* Effect.result(resumed.verify);
			return { unchanged, corruptionDetected: corruption._tag === "Failure" };
		}).pipe(Effect.result);
		const targetSequence = yield* targetBoot`SELECT next,published_through FROM seq`;
		const controls =
			yield* targetBoot`SELECT key,value FROM settings WHERE key IN ('transfer_state','transfer_journal','transfer_prepare','transfer_kernel','app_store_schema') ORDER BY key`;
		const archived =
			yield* targetBoot`SELECT key,value FROM settings WHERE key LIKE ${`transfer-history:${transferId}:%`} ORDER BY key`;
		const activeRemote = yield* targetBoot`SELECT key FROM settings WHERE key LIKE 'remote_database:%'`;
		const receipt = yield* targetBoot`SELECT value FROM settings WHERE key='receipt:example'`;
		const watcher = yield* targetBoot`SELECT value FROM settings WHERE key='source.watcher_baseline'`;
		console.log(JSON.stringify({ result, targetSequence, controls, archived, activeRemote, watcher, receipt }));
	}).pipe(Effect.scoped, Effect.provide(BunCrypto.layer)),
);
