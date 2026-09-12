import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Redacted, Ref, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { parseDescriptor, render } from "@comms/storage/store";
import { databaseLayer } from "../../src/kernel/remote-database.ts";
import { initializeTransferApp } from "../../src/kernel/transfer-app-initialize.ts";
import { remoteAppKernelSchema } from "../../../boot/src/app-kernel-schema.ts";
import { launchRemoteRoot } from "../../../boot/src/remote-root-launcher.ts";
import { remoteRuntime } from "../../../boot/src/remote-runtime.ts";
import { launchChild } from "../../../boot/src/child-process.ts";
import { remoteOwnerInventory } from "../../../boot/src/remote-owner-inventory.ts";
import { configuration } from "../../../boot/test/fixtures/remote-keeper-config.ts";

const epoch = "ad".repeat(32);
const identity = "12345678-1234-4234-8234-123456789abc";
const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	if (process.env.TRANSFER_APP_CHILD === "1") {
		assert.equal(process.env.COMMS_REMOTE_BOOT_TEST_CONFIG, undefined);
		assert.equal(process.env.COMMS_REMOTE_ROOT_CONFIG, undefined);
		const store = yield* parseDescriptor(process.env.APP_STORE ?? "");
		yield* Effect.gen(function* () {
			const sql = yield* SqlClient;
			const source = yield* fs.realPath(fileURLToPath(new URL("../../src", import.meta.url)));
			const before = yield* sql`SELECT * FROM store_identity`;
			const first = yield* initializeTransferApp(sql, epoch, source);
			assert(first.core.length > 0);
			assert(first.extensions.some((row) => row.extension === "subscriptions"));
			assert.deepEqual(yield* initializeTransferApp(sql, epoch, source), first);
			assert.deepEqual(yield* sql`SELECT * FROM store_identity`, before);
			assert.deepEqual(yield* sql`SELECT epoch FROM kernel_writer`, [{ epoch }]);
			assert.equal((yield* sql`SELECT * FROM messages`).length, 0);
			assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
			assert((yield* sql`SELECT name FROM protected_sql_tables`).length > 0);
			if (store._tag === "mysql") {
				yield* sql`INSERT INTO kernel_migration_intent(singleton,scope,name,epoch) VALUES(1,'fixture','pending',${epoch})`;
				assert.equal((yield* initializeTransferApp(sql, epoch, source).pipe(Effect.result))._tag, "Failure");
				assert.equal((yield* sql`SELECT * FROM kernel_migration_intent`).length, 1);
				assert.deepEqual(yield* sql`SELECT migration_id,name FROM core_migrations ORDER BY migration_id`, first.core);
			}
		}).pipe(Effect.provide(databaseLayer(store)));
		yield* fs.writeFileString(process.env.TRANSFER_APP_RESULT ?? "", "verified");
		return;
	}
	const config = yield* configuration;
	assert(config.app.database.startsWith("comms_transfer_app_"));
	assert.notEqual(config.appConnection.username, config.bootConnection.username);
	assert.notEqual(config.app.database, config.boot.database);
	const root = process.env.TRANSFER_APP_ROOT ?? (yield* fs.realPath(yield* fs.makeTempDirectoryScoped()));
	if (!process.env.COMMS_REMOTE_ROOT_CONFIG) {
		const code = yield* Effect.scoped(
			launchRemoteRoot(config, {
				dataDirectory: root,
				entry: fileURLToPath(import.meta.url),
				env: { TRANSFER_APP_ROOT: root },
			}),
		);
		assert.equal(Number(code), 0);
		yield* remoteOwnerInventory(root);
		console.log("TRANSFER_APP_INITIALIZE_NATIVE_PASSED");
		return;
	}
	const runtime = yield* remoteRuntime(config, root);
	yield* runtime.withStore(
		config.bootApp,
		Effect.gen(function* () {
			const sql = yield* SqlClient;
			// Fresh dedicated database: insertion refuses accidental reuse, never drops preexisting data.
			for (const operation of remoteAppKernelSchema(sql, config.appConnection.username)) yield* operation;
			yield* sql`INSERT INTO store_identity(singleton,store_id,initialized_at,transferred_to) VALUES(1,${identity},1,NULL)`;
			yield* sql`INSERT INTO kernel_writer(singleton,epoch) VALUES(1,${epoch})`;
		}),
	);
	const attempt = "ae".repeat(32);
	const remote = yield* runtime.reserveOwner(config.app, attempt);
	const child = yield* launchChild({
		entry: fileURLToPath(import.meta.url),
		cwd: root,
		attempt,
		receipt: `${root}/closed`,
		remote,
		env: {
			APP_STORE: Redacted.value(yield* render(config.app)),
			TRANSFER_APP_CHILD: "1",
			TRANSFER_APP_RESULT: `${root}/result`,
		},
	});
	yield* child.exited;
	yield* child.stop;
	assert((yield* Ref.get(child.stderr)).length === 0);
	assert.equal(yield* fs.readFileString(`${root}/result`), "verified");
	console.log("TRANSFER_APP_CHILD_VERIFIED");
	const owner = yield* Schema.decodeEffect(
		Schema.fromJsonString(Schema.Struct({ state: Schema.String, sessions: Schema.Array(Schema.Unknown) })),
	)(yield* fs.readFileString(`${root}/remote-owners/${attempt}.json`));
	assert.equal(owner.state, "closed");
	assert(owner.sessions.length > 0);
}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.provide(BunServices.layer));
if (process.env.TRANSFER_APP_CHILD === "1") console.log("COMMS_CHILD_PORT=12345");
program.pipe(BunRuntime.runMain);
