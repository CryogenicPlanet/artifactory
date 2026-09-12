import { strict as assert } from "node:assert";
import { BunRuntime } from "@effect/platform-bun";
import { writeTransferReceipt } from "@comms/storage/store-transfer-receipt";
import type { TransferPreparation } from "@comms/storage/store-transfer-schema";
import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { makeTransferKernelInitializer } from "../../src/transfer-kernel-initialize.ts";
import { makeTransferBootstrap } from "../../src/transfer-bootstrap.ts";
import { bootstrapConfiguration, bootstrapServices, openBootstrapClient } from "./transfer-bootstrap-config.ts";

Effect.gen(function* () {
	const config = yield* bootstrapConfiguration;
	const app = yield* openBootstrapClient(config.writer),
		boot = yield* openBootstrapClient(config.boot);
	const preparation: TransferPreparation = {
		phase: "preparing",
		sentinel: "pending",
		initialized_at: 123456,
		epoch: "a".repeat(64),
		selection: {
			version: 1,
			transfer_id: "22222222-2222-4222-8222-222222222222",
			store_id: "11111111-1111-4111-8111-111111111111",
			data_directory: config.dataDirectory,
			source: {
				engine: "sqlite",
				endpoint: null,
				boot: `${config.dataDirectory}/source-boot.sqlite`,
				app: `${config.dataDirectory}/source-app.sqlite`,
			},
			target: {
				engine: "mysql",
				endpoint: `${config.app.host}:${config.app.port}`,
				boot: config.boot.database,
				app: config.app.database,
			},
		},
	};
	yield* (yield* FileSystem.FileSystem).makeDirectory(
		`${config.dataDirectory}/transfers/${preparation.selection.transfer_id}`,
		{ recursive: true, mode: 0o700 },
	);
	yield* writeTransferReceipt(preparation);
	const bootstrap = yield* makeTransferBootstrap(config).pipe(Effect.provideService(SqlClient.SqlClient, boot));
	yield* bootstrap(preparation, writeTransferReceipt({ ...preparation, sentinel: "ready" })).pipe(
		Effect.provideService(SqlClient.SqlClient, app),
	);
	if (process.argv[3] === "positive") {
		assert.deepEqual(yield* app`SELECT transferred_to FROM store_identity`, [
			{ transferred_to: `transfer:${preparation.selection.transfer_id}` },
		]);
		const initialize = yield* makeTransferKernelInitializer(config).pipe(
			Effect.provideService(SqlClient.SqlClient, boot),
		);
		yield* initialize(preparation.selection, preparation).pipe(Effect.provideService(SqlClient.SqlClient, app));
		assert.deepEqual(yield* app`SELECT store_id,initialized_at,transferred_to FROM store_identity`, [
			{ store_id: preparation.selection.store_id, initialized_at: preparation.initialized_at, transferred_to: null },
		]);
		assert.deepEqual(yield* app`SELECT epoch FROM kernel_writer`, [{ epoch: preparation.epoch }]);
		assert.deepEqual(yield* boot`SELECT MAX(migration_id) AS version FROM boot_migrations`, [{ version: 20 }]);
		assert.deepEqual(yield* boot`SELECT value FROM settings WHERE ${boot("key")}='transfer_state'`, [
			{ value: "in_progress" },
		]);
		yield* bootstrap({ ...preparation, sentinel: "ready" }, Effect.die("Ready receipt must not be rewritten")).pipe(
			Effect.provideService(SqlClient.SqlClient, app),
		);
		yield* initialize(preparation.selection, preparation).pipe(Effect.provideService(SqlClient.SqlClient, app));
		process.stdout.write("NATIVE_BOOTSTRAP_READY_VERIFIED\n");
	}
}).pipe(Effect.scoped, Effect.provide(bootstrapServices), BunRuntime.runMain);
