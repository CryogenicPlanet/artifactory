import { strict as assert } from "node:assert";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { clientLayer } from "@comms/storage/client";
import { type Store } from "@comms/storage/store";
import { type TransferPreparation, TransferRejected } from "@comms/storage/store-transfer-schema";
import { writeTransferReceipt } from "@comms/storage/store-transfer-receipt";
import { makeTransferBootstrap } from "../../src/transfer-bootstrap.ts";
import { makeTransferKernelInitializer } from "../../src/transfer-kernel-initialize.ts";
import { assertBootTransferState } from "../../src/store-transfer-state.ts";

const directory = process.argv[2];
if (!directory) throw Error("Missing isolated data directory");
await Effect.runPromise(
	Effect.gen(function* () {
		const bootStore: Store = { _tag: "file", filename: `${directory}/boot.sqlite` };
		const appStore: Store = { _tag: "file", filename: `${directory}/app.sqlite` };
		const boot = Context.get(yield* Layer.build(clientLayer(bootStore)), SqlClient.SqlClient);
		const app = Context.get(yield* Layer.build(clientLayer(appStore)), SqlClient.SqlClient);
		const preparation: TransferPreparation = {
			phase: "preparing",
			sentinel: "pending",
			initialized_at: 123456,
			epoch: "a".repeat(64),
			selection: {
				version: 1,
				transfer_id: "22222222-2222-4222-8222-222222222222",
				store_id: "11111111-1111-4111-8111-111111111111",
				data_directory: directory,
				source: {
					engine: "sqlite",
					endpoint: null,
					boot: `${directory}/source-boot.sqlite`,
					app: `${directory}/source-app.sqlite`,
				},
				target: { engine: "sqlite", endpoint: null, boot: bootStore.filename, app: appStore.filename },
			},
		};
		yield* (yield* FileSystem.FileSystem).makeDirectory(`${directory}/transfers/${preparation.selection.transfer_id}`, {
			recursive: true,
			mode: 0o700,
		});
		const bootstrap = yield* makeTransferBootstrap({ appStore, bootStore }).pipe(
			Effect.provideService(SqlClient.SqlClient, boot),
		);
		const fs = yield* FileSystem.FileSystem;
		const filename = `${directory}/transfers/${preparation.selection.transfer_id}/journal.json`;
		const refuse = Effect.gen(function* () {
			const result = yield* bootstrap(preparation, Effect.void).pipe(
				Effect.provideService(SqlClient.SqlClient, app),
				Effect.result,
			);
			assert.equal(result._tag, "Failure");
			if (result._tag === "Failure") assert(Schema.is(TransferRejected)(result.failure));
			assert.equal((yield* boot`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`).length, 0);
		});
		yield* refuse; // Missing receipt cannot create a sentinel.
		assert.equal((yield* app`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`).length, 0);
		yield* fs.writeFileString(`${filename}.next`, JSON.stringify(preparation));
		yield* refuse; // A staged-only receipt is not acknowledged authority.
		yield* fs.remove(`${filename}.next`);
		for (const mismatch of [
			{ ...preparation, epoch: "b".repeat(64) },
			{ ...preparation, initialized_at: preparation.initialized_at + 1 },
			{ ...preparation, sentinel: "ready" },
			{ ...preparation, selection: { ...preparation.selection, store_id: "33333333-3333-4333-8333-333333333333" } },
			{ phase: "in_progress", binding: { ...preparation.selection, manifest: "a".repeat(64) } },
		]) {
			yield* fs.writeFileString(filename, JSON.stringify(mismatch));
			yield* refuse;
			assert.equal((yield* app`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`).length, 0);
		}
		yield* fs.remove(filename);
		yield* writeTransferReceipt(preparation);
		yield* refuse; // A no-op markReady cannot permit boot DDL.
		const beforeBoot = Effect.gen(function* () {
			assert.equal((yield* boot`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`).length, 0);
			assert.deepEqual(yield* app`SELECT transferred_to FROM store_identity`, [
				{ transferred_to: `transfer:${preparation.selection.transfer_id}` },
			]);
		});
		const crash = yield* bootstrap(preparation, beforeBoot.pipe(Effect.andThen(Effect.fail("before-ready")))).pipe(
			Effect.provideService(SqlClient.SqlClient, app),
			Effect.result,
		);
		assert.equal(crash._tag, "Failure");
		assert.equal((yield* boot`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`).length, 0);
		const ready: TransferPreparation = { ...preparation, sentinel: "ready" };
		yield* bootstrap(preparation, beforeBoot.pipe(Effect.andThen(writeTransferReceipt(ready)))).pipe(
			Effect.provideService(SqlClient.SqlClient, app),
		);
		assert.deepEqual(yield* boot`SELECT migration_id FROM boot_migrations ORDER BY migration_id DESC LIMIT 1`, [
			{ migration_id: 20 },
		]);
		assert.equal((yield* assertBootTransferState(boot).pipe(Effect.result))._tag, "Failure");
		const initialize = yield* makeTransferKernelInitializer({ appStore, bootStore }).pipe(
			Effect.provideService(SqlClient.SqlClient, boot),
		);
		yield* initialize(preparation.selection, preparation).pipe(Effect.provideService(SqlClient.SqlClient, app));
		assert.deepEqual(yield* app`SELECT store_id,transferred_to FROM store_identity`, [
			{ store_id: preparation.selection.store_id, transferred_to: null },
		]);
		assert.deepEqual(yield* app`SELECT epoch FROM kernel_writer`, [{ epoch: preparation.epoch }]);
		yield* bootstrap(ready, Effect.die("Must not rewrite ready preparation")).pipe(
			Effect.provideService(SqlClient.SqlClient, app),
		);
		assert.equal((yield* boot`SELECT key FROM settings WHERE key LIKE 'app_store_%'`).length, 0);
		// An ordinary startup's ownership record is not adoptable as transfer progress.
		yield* boot`INSERT INTO settings(key,value) VALUES('app_store_schema','{}')`;
		const conflict = yield* bootstrap(ready, Effect.void).pipe(
			Effect.provideService(SqlClient.SqlClient, app),
			Effect.result,
		);
		assert.equal(conflict._tag, "Failure");
		if (conflict._tag === "Failure") assert(Schema.is(TransferRejected)(conflict.failure));
		process.stdout.write("SENTINEL_BOOTSTRAP_VERIFIED\n");
	}).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
