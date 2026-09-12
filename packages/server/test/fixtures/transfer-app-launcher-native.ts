import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { remoteAppKernelSchema } from "../../../boot/src/app-kernel-schema.ts";
import { launchRemoteRoot } from "../../../boot/src/remote-root-launcher.ts";
import { remoteRuntime } from "../../../boot/src/remote-runtime.ts";
import { runTransferApp } from "../../../boot/src/transfer-app-launcher.ts";
import { remoteOwnerInventory } from "../../../boot/src/remote-owner-inventory.ts";
import { configuration } from "../../../boot/test/fixtures/remote-keeper-config.ts";

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const config = yield* configuration;
	assert(config.app.database.startsWith("comms_transfer_launcher_"));
	const root = process.env.TRANSFER_LAUNCHER_ROOT ?? (yield* fs.realPath(yield* fs.makeTempDirectoryScoped()));
	if (!process.env.COMMS_REMOTE_ROOT_CONFIG) {
		const code = yield* Effect.scoped(
			launchRemoteRoot(config, {
				dataDirectory: root,
				entry: fileURLToPath(import.meta.url),
				env: { TRANSFER_LAUNCHER_ROOT: root },
			}),
		);
		assert.equal(Number(code), 0);
		yield* remoteOwnerInventory(root);
		console.log("TRANSFER_APP_LAUNCHER_NATIVE_VERIFIED");
		return;
	}
	const runtime = yield* remoteRuntime(config, root);
	const epoch = "ad".repeat(32);
	yield* runtime.withStore(
		config.bootApp,
		Effect.gen(function* () {
			const sql = yield* SqlClient;
			for (const statement of remoteAppKernelSchema(sql, config.appConnection.username)) yield* statement;
			yield* sql`INSERT INTO store_identity(singleton,store_id,initialized_at,transferred_to) VALUES(1,'12345678-1234-4234-8234-123456789abc',1,NULL)`;
			yield* sql`INSERT INTO kernel_writer(singleton,epoch) VALUES(1,${epoch})`;
		}),
	);
	const attempt = "ac".repeat(32);
	const transfer = path.join(root, "transfers", "12345678-1234-4234-8234-123456789abc");
	yield* fs.makeDirectory(transfer, { recursive: true, mode: 0o700 });
	const remote = yield* runtime.reserveOwner(config.app, attempt);
	const result = yield* runTransferApp({
		sourceDirectory: yield* fs.realPath(path.resolve(import.meta.dirname, "../../src")),
		transferDirectory: transfer,
		dataDirectory: root,
		targetStore: config.app,
		epoch,
		sourceEngine: "sqlite",
		attempt,
		remote,
		isolated: false,
	});
	const decoded = yield* Schema.decodeEffect(
		Schema.fromJsonString(
			Schema.Struct({
				core: Schema.Array(Schema.Struct({ migration_id: Schema.Number })),
				extensionProofs: Schema.Array(
					Schema.Struct({ extension: Schema.String, sourceChecksum: Schema.String, targetChecksum: Schema.String }),
				),
			}),
		),
	)(result);
	assert.equal(decoded.core.at(-1)?.migration_id, 11);
	assert(decoded.extensionProofs.length > 0);
	const owner = yield* Schema.decodeEffect(
		Schema.fromJsonString(Schema.Struct({ state: Schema.String, sessions: Schema.Array(Schema.Unknown) })),
	)(yield* fs.readFileString(path.join(root, "remote-owners", `${attempt}.json`)));
	assert.equal(owner.state, "closed");
	assert(owner.sessions.length > 0);
	yield* runtime.assertAccountClosed(attempt, config.app);
	yield* runtime.withStore(
		config.bootApp,
		Effect.gen(function* () {
			const sql = yield* SqlClient;
			assert.equal((yield* sql`SELECT * FROM messages`).length, 0);
			assert.deepEqual(yield* sql`SELECT epoch FROM kernel_writer`, [{ epoch }]);
		}),
	);
}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.provide(BunServices.layer));
program.pipe(
	Effect.catchCause(() => Effect.die("Native transfer app launcher fixture failed")),
	BunRuntime.runMain,
);
