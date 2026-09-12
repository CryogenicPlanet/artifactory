import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { on } from "@comms/storage/dialect";
import { withDatabase } from "@comms/storage/store";
import { Console, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { remoteAppKernelSchema } from "../../src/app-kernel-schema.ts";
import { remoteAppStoreIdentity, verifyRemoteAppIdentity } from "../../src/app-store-identity.ts";
import { EventError } from "../../src/events.ts";
import { remoteDatabaseJournal } from "../../src/remote-database-journal.ts";
import { remoteDbOps } from "../../src/remote-db-ops.ts";
import { remoteNativeCopy } from "../../src/remote-native-copy.ts";
import { launchRemoteRoot } from "../../src/remote-root-launcher.ts";
import { remoteRuntime } from "../../src/remote-runtime.ts";
import { configuration } from "./remote-keeper-config.ts";

const Donor = Schema.fromJsonString(
	Schema.Struct({ storeId: Schema.String, body: Schema.String, bytes: Schema.String }),
);
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(process.env.FOREIGN_BACKUP_ROOT ?? process.argv[2] ?? "");
	const phase = process.env.FOREIGN_BACKUP_PHASE ?? process.argv[3];
	assert.ok(phase === "donor" || phase === "recipient" || phase === "reopen");
	const config = yield* configuration;
	assert.match(config.app.database, /^comms_[a-z_]+_app$/);
	assert.match(config.boot.database, /^comms_[a-z_]+_boot$/);
	if (!process.env.COMMS_REMOTE_ROOT_CONFIG) {
		const code = yield* Effect.scoped(
			launchRemoteRoot(config, {
				dataDirectory: root,
				entry: fileURLToPath(import.meta.url),
				env: { FOREIGN_BACKUP_PHASE: phase, FOREIGN_BACKUP_ROOT: root },
			}),
		);
		assert.equal(Number(code), 0);
		yield* Console.log(`FOREIGN_BACKUP_${phase}_VERIFIED`);
		return;
	}
	yield* Console.error(`foreign-backup:${phase}:runtime`);
	const runtime = yield* remoteRuntime(config, root);
	const boot = runtime.bootSql;
	const identity = yield* remoteAppStoreIdentity(config.app).pipe(Effect.provideService(SqlClient.SqlClient, boot));
	const original = runtime.withStore(
		config.app,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return JSON.stringify({
				identity: yield* sql`SELECT * FROM store_identity ORDER BY singleton`,
				writer: yield* sql`SELECT * FROM kernel_writer ORDER BY singleton`,
				batches: yield* sql`SELECT * FROM mutation_batches ORDER BY id`,
				outbox: yield* sql`SELECT * FROM outbox ORDER BY seq`,
				rows: yield* on(sql, {
					sqlite: () => {
						throw new Error("Native fixture required");
					},
					pg: () => sql`SELECT id,body,encode(payload,'hex') AS bytes FROM fixture_messages ORDER BY id`,
					mysql: () => sql`SELECT id,body,LOWER(HEX(payload)) AS bytes FROM fixture_messages ORDER BY id`,
				}),
			});
		}),
	);
	const identitySettings = boot`SELECT ${boot("key")},value FROM settings WHERE ${boot("key")} IN
  ('app_store_id','app_store_initialized','app_store_database','app_store_adoption') ORDER BY ${boot("key")}`.pipe(
		Effect.map(JSON.stringify),
	);
	if (phase === "reopen") {
		assert.equal(yield* original, yield* fs.readFileString(`${root}/original.json`));
		assert.equal(yield* identitySettings, yield* fs.readFileString(`${root}/identity.json`));
		const status = yield* identity.status;
		assert.equal(status.selected_database, config.app.database);
		assert.equal(status.adoption_phase, "ready");
		return;
	}
	yield* on(boot, {
		sqlite: () => {
			throw new Error("Native fixture required");
		},
		pg: () => boot`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
		mysql: () => boot`CREATE TABLE settings(\`key\` VARCHAR(255) PRIMARY KEY,value LONGTEXT NOT NULL)`,
	});
	yield* boot`CREATE TABLE seq(singleton INTEGER PRIMARY KEY)`;
	yield* boot`INSERT INTO seq VALUES(1)`;
	const adoption = yield* identity.reserve;
	const body = `${phase}: café 🐘\n"quoted"\\tail`;
	const bytes = "00017fff80414200";
	yield* runtime.withStore(
		config.app,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const role = decodeURIComponent(new URL(Redacted.value(config.app.url)).username);
			for (const operation of remoteAppKernelSchema(sql, role)) yield* operation;
			yield* sql.withTransaction(verifyRemoteAppIdentity(adoption));
			yield* on(sql, {
				sqlite: () => {
					throw new Error("Native fixture required");
				},
				pg: () => sql`CREATE TABLE fixture_messages(id INTEGER PRIMARY KEY,body TEXT NOT NULL,payload BYTEA NOT NULL)`,
				mysql: () =>
					sql`CREATE TABLE fixture_messages(id INTEGER PRIMARY KEY,body TEXT NOT NULL,payload BLOB NOT NULL)`,
			});
			yield* on(sql, {
				sqlite: () => {
					throw new Error("Native fixture required");
				},
				pg: () => sql`INSERT INTO fixture_messages VALUES(1,${body},decode(${bytes},'hex'))`,
				mysql: () => sql`INSERT INTO fixture_messages VALUES(1,${body},UNHEX(${bytes}))`,
			});
		}),
	);
	yield* identity.complete(adoption);
	const before = yield* original;
	const settings = yield* identitySettings;
	const native = yield* remoteNativeCopy(runtime);
	const service = yield* remoteDbOps({
		store: identity.store,
		bootStore: config.boot,
		dataDirectory: root,
		withStore: runtime.withStore,
		withNative: native,
		assertAccountClosed: runtime.assertAccountClosed,
	}).pipe(Effect.provideService(SqlClient.SqlClient, boot));
	if (phase === "donor") {
		yield* Console.error("foreign-backup:dump");
		assert.ok((yield* service.clone({ _tag: "file", filename: `${root}/foreign.backup` })) > 0n);
		yield* fs.writeFileString(
			`${root}/donor.json`,
			Schema.encodeSync(Donor)({ storeId: adoption.store_id, body, bytes }),
		);
		assert.equal(yield* original, before);
		return;
	}
	const donor = yield* fs.readFileString(`${root}/donor.json`).pipe(Effect.flatMap(Schema.decodeEffect(Donor)));
	assert.notEqual(adoption.store_id, donor.storeId);
	yield* Console.error("foreign-backup:restore");
	const result = yield* service
		.restoreInto({ path: `${root}/foreign.backup`, engine: config.appConnection.engine, legacy_store_id: null })
		.pipe(Effect.result);
	assert.equal(result._tag, "Failure");
	if (result._tag !== "Failure") return yield* Effect.die("Foreign identity unexpectedly restored");
	assert.equal(Schema.is(EventError)(result.failure) && result.failure.code === "app_store_mismatch", true);
	yield* Console.error("foreign-backup:identity-refused");
	assert.equal(yield* original, before);
	assert.equal(yield* identitySettings, settings);
	const journal = yield* remoteDatabaseJournal(config.boot, root).pipe(
		Effect.provideService(SqlClient.SqlClient, boot),
	);
	const records = yield* journal.list;
	assert.equal(records.length, 1);
	const record = records[0];
	assert.ok(record && record.kind === "restore" && record.phase === "ready" && record.database !== config.app.database);
	// The actual native load completed into an unselected target; neither source nor artifact was forged.
	yield* runtime.assertAccountClosed(record.id, yield* journal.credential(record.id));
	yield* runtime.withStore(
		yield* withDatabase(config.app, record.database),
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql`SELECT store_id FROM store_identity WHERE singleton=1`;
			assert.equal(rows[0]?.store_id, donor.storeId);
			const content = yield* on(sql, {
				sqlite: () => {
					throw new Error("Native fixture required");
				},
				pg: () => sql`SELECT body,encode(payload,'hex') AS bytes FROM fixture_messages WHERE id=1`,
				mysql: () => sql`SELECT body,LOWER(HEX(payload)) AS bytes FROM fixture_messages WHERE id=1`,
			});
			assert.equal(content[0]?.body, donor.body);
			assert.equal(content[0]?.bytes, donor.bytes);
		}),
	);
	yield* fs.writeFileString(`${root}/original.json`, before);
	yield* fs.writeFileString(`${root}/identity.json`, settings);
});
main.pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
	Effect.catchCause(() => Effect.die("Foreign native backup acceptance failed; credentials omitted")),
	BunRuntime.runMain,
);
