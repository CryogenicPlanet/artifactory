import { extensionCapabilities } from "../../src/ext/core/capabilities.ts";
import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { layer as topicsLayer } from "../../src/ext/core/topics.ts";
import { layer as pagesLayer } from "../../src/ext/core/pages.ts";
import { layer as messagesLayer } from "../../src/ext/core/messages.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";
import { layer as extensionsLayer } from "../../src/kernel/ext.ts";
import { Etag } from "effect/unstable/http";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { BunServices, BunHttpPlatform } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { remoteAppKernelSchema } from "../../../boot/src/app-kernel-schema.ts";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
import { writerGate } from "../../src/kernel/database.ts";
import { assertNoPendingMigration } from "../../src/kernel/migration-intent.ts";
import { makeExtensionMigrate } from "../../src/kernel/extension-migrations.ts";
import { migrate } from "../../src/kernel/migrations.ts";
const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const filename = process.env.COMMS_REMOTE_KERNEL_TEST_CONFIG;
if (!filename) throw new Error("Missing disposable kernel schema configuration");
const settings = await readFile(filename, "utf8")
	.then(Schema.decodeSync(Schema.fromJsonString(Settings)))
	.catch(() => {
		throw new Error("Invalid disposable kernel configuration");
	});
if (settings.database !== "comms_schema_kernel") throw new Error("Requires isolated schema test database");
const options = {
	connection: { ...settings, password: Redacted.make(settings.password), tls: false },
	attempt: "b2".repeat(32),
};
const layer = remoteClientLayer({ ...options, register: () => Effect.void }).pipe(
	Layer.provide(remoteInspectorLayer(options)),
);
let phase = "connect";
await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const fs = yield* FileSystem.FileSystem;
			const boot: BootChannel["Service"] = {
				epoch: "current",
				filename: ":memory:",
				generation: 1,
				backup: Effect.void,
				changed: () => Effect.never,
				fence: Effect.succeed({ published_through: 0 }),
				events: (input) => Effect.succeed({ items: [], cursor: input.since ?? 0, timed_out: false, drained: false }),
				reserve: (transaction, count) => Effect.succeed({ transaction, from: 1, to: count }),
				abort: () => Effect.void,
				append: () => Effect.succeed({ published_through: 0 }),
			};
			const loadExtensions = (directory: string) =>
				Effect.void.pipe(
					Effect.provide(
						Layer.unwrap(
							Effect.map(extensionCapabilities, (capabilities) => extensionsLayer(directory, capabilities)),
						).pipe(
							Layer.provide(
								topicsLayer.pipe(
									Layer.provideMerge(messagesLayer.pipe(Layer.provideMerge(publicationLayer))),
									Layer.provideMerge(pagesLayer(directory)),
								),
							),
							Layer.provide(BunHttpPlatform.layer),
							Layer.provide(Etag.layer),
						),
					),
					Effect.provide(lifecycleLayer),
					Effect.provideService(BootChannel, boot),
					Effect.provideService(SqlClient.SqlClient, sql),
				);

			const root = yield* fs.makeTempDirectoryScoped({
				directory: `${process.cwd()}/scripts`,
				prefix: "kernel-migrations-",
			});
			const reset = Effect.gen(function* () {
				for (const table of [
					"kernel_migration_intent",
					"protected_sql_tables",
					"extension_migrations",
					"migrations",
					"outbox",
					"mutation_batches",
					"store_identity",
					"kernel_writer",
					"kernel_probe",
					"editable_probe",
				])
					yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
			});
			if (process.argv[2] === "resume") {
				phase = "physical-reconnect";
				if (settings.engine === "mysql") {
					const pending = yield* initializeRemoteKernelSchema(sql, "current").pipe(Effect.result);
					assert.equal(pending._tag, "Failure");
					if (pending._tag === "Failure") {
						assert(Schema.is(KernelError)(pending.failure));
						assert.equal(pending.failure.code, "migration_recovery_required");
					}
					assert.deepEqual(yield* sql`SELECT name FROM kernel_migration_intent`, [{ name: "failure" }]);
				} else yield* initializeRemoteKernelSchema(sql, "current");
				assert.deepEqual(yield* sql`SELECT value FROM kernel_probe`, [{ value: "once" }]);
				yield* reset;
				console.log(`KERNEL_RECONNECT_VERIFIED ${settings.engine}`);
				return;
			}
			yield* reset;
			for (const statement of remoteAppKernelSchema(sql, settings.username)) yield* statement;
			yield* sql`INSERT INTO kernel_writer(singleton,epoch) VALUES(1,'current')`;
			if (settings.engine === "mysql") {
				phase = "malformed-intent";
				yield* sql`CREATE TABLE kernel_migration_intent(singleton INTEGER,scope TEXT,name TEXT,epoch TEXT) ENGINE=MyISAM`;
				assert.equal((yield* initializeRemoteKernelSchema(sql, "current").pipe(Effect.result))._tag, "Failure");
				assert.deepEqual(
					yield* sql`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='protected_sql_tables'`,
					[],
				);
				yield* sql`DROP TABLE kernel_migration_intent`;
			}
			phase = "initialize";
			yield* initializeRemoteKernelSchema(sql, "current");
			yield* initializeRemoteKernelSchema(sql, "current");
			assert.equal((yield* sql.withTransaction(writerGate(sql, "stale")).pipe(Effect.result))._tag, "Failure");
			phase = "extension";
			const extension = yield* makeExtensionMigrate(sql, "current", "example");
			yield* extension("create", "CREATE TABLE kernel_probe(value TEXT)", { protect: true });
			assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables`, [{ name: "kernel_probe" }]);
			yield* Effect.all(
				[
					extension("insert", "INSERT INTO kernel_probe VALUES('once')"),
					extension("insert", "INSERT INTO kernel_probe VALUES('once')"),
				],
				{ concurrency: 2 },
			);
			assert.deepEqual(yield* sql`SELECT value FROM kernel_probe`, [{ value: "once" }]);
			yield* assertNoPendingMigration(sql);
			phase = "editable-success";
			yield* fs.writeFileString(
				`${root}/001_create.ts`,
				'import {Effect} from "effect"; import {SqlClient} from "effect/unstable/sql"; export default Effect.gen(function*(){ const sql=yield* SqlClient.SqlClient; yield* sql`CREATE TABLE editable_probe(value TEXT)`; });',
			);

			yield* migrate(root, "current").pipe(Effect.provideService(SqlClient.SqlClient, sql));
			yield* migrate(root, "current").pipe(Effect.provideService(SqlClient.SqlClient, sql));
			yield* assertNoPendingMigration(sql);
			if (settings.engine === "mysql") {
				phase = "durable-failed-DDL";
				yield* fs.writeFileString(
					`${root}/002_partial.ts`,
					'import {Effect} from "effect"; import {SqlClient} from "effect/unstable/sql"; export default Effect.gen(function*(){ const sql=yield* SqlClient.SqlClient; yield* sql`ALTER TABLE editable_probe ADD COLUMN kept INTEGER`; yield* Effect.fail("after committed DDL"); });',
				);
				const failed = yield* migrate(root, "current").pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.exit,
				);
				yield* fs.remove(`${root}/002_partial.ts`);
				assert.equal(failed._tag, "Failure");
				assert.equal((yield* assertNoPendingMigration(sql).pipe(Effect.result))._tag, "Failure");
				assert.equal((yield* initializeRemoteKernelSchema(sql, "current").pipe(Effect.result))._tag, "Failure");
				assert.equal(
					(yield* migrate(root, "current").pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.result))._tag,
					"Failure",
				);
				assert.deepEqual(yield* sql`SELECT name FROM kernel_migration_intent`, [{ name: "batch" }]);
				yield* sql`SELECT kept FROM editable_probe`;
				// Independent fault injection in this disposable database; production never clears an unknown intent.
				yield* sql`DELETE FROM kernel_migration_intent`;
				const directory = `${root}/ext`;
				yield* fs.makeDirectory(directory);
				yield* loadExtensions(directory);
				phase = "write-extension";
				yield* fs.writeFileString(
					`${directory}/broken.ts`,
					'import {Effect} from "effect"; export default api => api.migrate("failure", "ALTER TABLE editable_probe ADD COLUMN kept INTEGER").pipe(Effect.catch(() => Effect.void));',
				);
				phase = "caught-extension-load";
				const caught = yield* loadExtensions(directory).pipe(Effect.result);
				phase = `caught-extension-result-${caught._tag}`;
				assert.equal(caught._tag, "Failure");
				if (caught._tag === "Failure") {
					assert(Schema.is(KernelError)(caught.failure));
					assert.equal(caught.failure.code, "migration_recovery_required");
				}
				yield* sql`SELECT kept FROM editable_probe`;
				assert.equal((yield* sql`SELECT name FROM extension_migrations WHERE name='failure'`).length, 0);
				yield* fs.remove(`${directory}/broken.ts`);
				phase = "removed-extension-source";
				const removed = yield* loadExtensions(directory).pipe(Effect.result);
				assert.equal(removed._tag, "Failure");
				if (removed._tag === "Failure") {
					assert(Schema.is(KernelError)(removed.failure));
					assert.equal(removed.failure.code, "migration_recovery_required");
				}
			}
			console.log(`KERNEL_SCHEMA_VERIFIED ${settings.engine}`);
		}),
	).pipe(Effect.provide(layer), Effect.provide(BunServices.layer)),
).catch(() => {
	throw new Error(`Kernel schema fixture failed at ${phase}`);
});
