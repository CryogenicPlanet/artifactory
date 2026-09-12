import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { remoteAppKernelSchema } from "../../../boot/src/app-kernel-schema.ts";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
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
const filename = process.env.COMMS_MIGRATION_GUARD_CONFIG;
if (!filename) throw new Error("Missing disposable migration guard configuration");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
if (settings.database !== "comms_schema_guard") throw new Error("Requires exclusive migration guard database");
const options = {
	connection: { ...settings, password: Redacted.make(settings.password), tls: false },
	attempt: "a7".repeat(32),
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
			const root = yield* fs.makeTempDirectoryScoped();
			const reset = Effect.gen(function* () {
				for (const name of [
					"owned",
					"product",
					"core_migrations",
					"idempotency",
					"protected_sql_tables",
					"extension_migrations",
					"migrations",
					"kernel_migration_intent",
					"outbox",
					"mutation_batches",
					"store_identity",
					"kernel_writer",
				]) {
					phase = `reset-${name}`;
					yield* sql`DROP TABLE IF EXISTS ${sql(name)}`;
				}
				if (settings.engine === "mysql") {
					for (const statement of remoteAppKernelSchema(sql, settings.username)) yield* statement;
				} else {
					yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT)`;
					yield* sql`CREATE TABLE store_identity(singleton INTEGER PRIMARY KEY,store_id TEXT,initialized_at BIGINT,transferred_to TEXT)`;
					yield* sql`CREATE TABLE mutation_batches(id TEXT PRIMARY KEY,from_seq BIGINT,to_seq BIGINT,count BIGINT)`;
					yield* sql`CREATE TABLE outbox(seq BIGINT PRIMARY KEY,transaction_id TEXT,event TEXT,shipped_at BIGINT)`;
				}
				phase = "seed";
				yield* sql`INSERT INTO kernel_writer VALUES(1,'current')`;
				yield* sql`INSERT INTO store_identity VALUES(1,'retained',1,NULL)`;
				phase = "initialize";
				yield* initializeRemoteKernelSchema(sql, "current");
				yield* sql`CREATE TABLE core_migrations(migration_id INTEGER PRIMARY KEY,name VARCHAR(255))`;
				yield* sql`INSERT INTO core_migrations VALUES(1,'original')`;
				yield* sql`CREATE TABLE idempotency(id INTEGER PRIMARY KEY,value TEXT)`;
				yield* sql`INSERT INTO idempotency VALUES(1,'receipt')`;
				yield* sql`INSERT INTO mutation_batches VALUES('retained',1,1,1)`;
				// Exceed the raw SQL repair ceiling: migration safety has no 1,000-row/1 MiB board limit.
				for (let start = 0; start < 1200; start += 100)
					yield* sql`INSERT INTO outbox ${sql.insert(Array.from({ length: 100 }, (_, index) => ({ seq: start + index + 1, transaction_id: "retained", event: "雪😀".repeat(300), shipped_at: null })))}`;
			});
			const effectPath = JSON.stringify(import.meta.resolve("effect"));
			const sqlPath = JSON.stringify(import.meta.resolve("effect/unstable/sql"));
			const write = (directory: string, body: string) =>
				fs.writeFileString(
					`${directory}/001_probe.ts`,
					`import{Effect}from ${effectPath};import{SqlClient}from ${sqlPath};export default Effect.gen(function*(){const sql=yield*SqlClient.SqlClient;${body}});`,
				);
			if (process.argv[2] === "resume") {
				phase = "reconnect-missing-intent";
				assert.equal((yield* initializeRemoteKernelSchema(sql, "current").pipe(Effect.exit))._tag, "Failure");
				assert.equal(
					(yield* sql`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='kernel_migration_intent'`)
						.length,
					0,
				);
				console.log("MIGRATION_GUARD_RECONNECT_PASSED");
				return;
			}
			yield* reset;
			phase = "valid-extension-and-editable";
			const extension = yield* makeExtensionMigrate(sql, "current", "example");
			yield* extension("create", "CREATE TABLE owned(value TEXT)", { protect: true });
			yield* extension("upgrade", "ALTER TABLE owned ADD COLUMN extra INTEGER");
			const good = `${root}/good`;
			yield* fs.makeDirectory(good);
			yield* write(good, "yield*sql`CREATE TABLE product(value TEXT)`;yield*sql`INSERT INTO owned VALUES('valid',1)`;");
			yield* migrate(good, "current").pipe(Effect.provideService(SqlClient.SqlClient, sql));
			yield* assertNoPendingMigration(sql);
			assert.equal((yield* sql`SELECT * FROM outbox`).length, 1200);
			const statements = [
				"UPDATE store_identity SET store_id='changed'",
				"DELETE FROM outbox",
				"DELETE FROM mutation_batches",
				"DELETE FROM idempotency",
				"DELETE FROM protected_sql_tables",
				"DELETE FROM extension_migrations",
				"DELETE FROM core_migrations",
				"DELETE FROM migrations",
				"ALTER TABLE outbox ADD COLUMN extra INTEGER",
			];
			for (const [index, statement] of statements.entries()) {
				phase = `reject-extension-${index}`;
				if (settings.engine === "mysql" && index > 0) {
					yield* reset;
				}
				const run = yield* makeExtensionMigrate(sql, "current", "example");
				// Ensure every DELETE actually changes data, including the migration ledgers/registry.
				if (settings.engine === "mysql" && index > 0) {
					yield* sql`INSERT INTO protected_sql_tables VALUES('owned')`;
					yield* sql`INSERT INTO extension_migrations VALUES('example','seed','checksum')`;
					yield* sql`INSERT INTO migrations(migration_id,name) VALUES(1,'seed')`;
				}
				assert.equal((yield* run(`bad-${index}`, statement).pipe(Effect.exit))._tag, "Failure");
				assert.equal((yield* sql`SELECT * FROM extension_migrations WHERE name=${`bad-${index}`}`).length, 0);
				if (settings.engine === "mysql")
					assert.equal((yield* assertNoPendingMigration(sql).pipe(Effect.exit))._tag, "Failure");
				else assert.equal((yield* sql`SELECT * FROM outbox`).length, 1200);
			}
			if (settings.engine === "pg") {
				phase = "deferred-trigger";
				yield* sql`CREATE OR REPLACE FUNCTION guard_deferred_func() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN DELETE FROM outbox; RETURN NEW; END'`;
				yield* sql`CREATE CONSTRAINT TRIGGER guard_deferred AFTER INSERT ON owned DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_deferred_func()`;
				assert.equal(
					(yield* extension("deferred", "INSERT INTO owned VALUES('later',2)").pipe(Effect.exit))._tag,
					"Failure",
				);
				assert.equal((yield* sql`SELECT * FROM outbox`).length, 1200);
				yield* sql`DROP TRIGGER guard_deferred ON owned`;
				yield* sql`DROP FUNCTION guard_deferred_func()`;
			}
			phase = "reject-editable";
			yield* reset;
			const bad = `${root}/bad`;
			yield* fs.makeDirectory(bad);
			yield* write(bad, "yield*sql`DELETE FROM outbox`;");
			assert.equal(
				(yield* migrate(bad, "current").pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.exit))._tag,
				"Failure",
			);
			assert.equal((yield* sql`SELECT * FROM outbox`).length, 1200);
			if (settings.engine === "mysql") {
				phase = "changed-trigger-semantics";
				yield* reset;
				phase = "create-trigger";
				yield* sql`CREATE TRIGGER guard_trigger BEFORE INSERT ON outbox FOR EACH ROW SET NEW.event=NEW.event`
					.unprepared;
				phase = "run-trigger-migration";
				const trigger = `${root}/trigger`;
				yield* fs.makeDirectory(trigger);
				yield* write(
					trigger,
					"yield*sql`DROP TRIGGER guard_trigger`.unprepared;yield*sql`CREATE TRIGGER guard_trigger BEFORE UPDATE ON outbox FOR EACH ROW SET NEW.event=NEW.event`.unprepared;",
				);
				assert.equal(
					(yield* migrate(trigger, "current").pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.exit))._tag,
					"Failure",
				);
				assert.equal((yield* assertNoPendingMigration(sql).pipe(Effect.exit))._tag, "Failure");
				assert.deepEqual(
					yield* sql`SELECT EVENT_MANIPULATION AS manipulation FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='guard_trigger'`,
					[{ manipulation: "UPDATE" }],
				);
				phase = "missing-intent-refusal";
				yield* reset;
				phase = "drop-intent-migration";
				const destroy = yield* makeExtensionMigrate(sql, "current", "destroy");
				assert.equal(
					(yield* destroy("drop-intent", "DROP TABLE kernel_migration_intent").pipe(Effect.exit))._tag,
					"Failure",
				);
				assert.equal((yield* initializeRemoteKernelSchema(sql, "current").pipe(Effect.exit))._tag, "Failure");
			}
			console.log(`MIGRATION_GUARD_PASSED ${settings.engine}`);
		}),
	).pipe(Effect.provide(layer), Effect.provide(BunServices.layer)),
).catch(() => {
	throw new Error(`Migration guard failed at ${phase}`);
});
