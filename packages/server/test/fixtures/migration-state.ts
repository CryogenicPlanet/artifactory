import { strict as assert } from "node:assert";
import { BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrate } from "../../src/kernel/migrations.ts";
import { makeExtensionMigrate } from "../../src/kernel/extension-migrations.ts";

await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const fs = yield* FileSystem.FileSystem;
			const root = yield* fs.makeTempDirectoryScoped();
			yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT)`;
			yield* sql`INSERT INTO kernel_writer VALUES(1,'current')`;
			yield* sql`CREATE TABLE store_identity(singleton INTEGER PRIMARY KEY,store_id TEXT,initialized_at INTEGER,transferred_to TEXT)`;
			yield* sql`INSERT INTO store_identity VALUES(1,'retained-id',1,NULL)`;
			yield* sql`CREATE TABLE outbox(seq INTEGER PRIMARY KEY,event TEXT)`;
			yield* sql`INSERT INTO outbox VALUES(42,'retained-event')`;
			yield* sql`CREATE TABLE mutation_batches(id TEXT PRIMARY KEY,count INTEGER)`;
			yield* sql`INSERT INTO mutation_batches VALUES('retained-batch',1)`;
			const extension = yield* makeExtensionMigrate(sql, "current", "owner");
			yield* extension("create", "CREATE TABLE owned(value TEXT)", { protect: true });
			yield* extension("add_column", "ALTER TABLE owned ADD COLUMN extra TEXT");
			yield* extension("seed", "INSERT INTO owned VALUES('retained','valid upgrade')");
			const effectPath = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
				import.meta.resolve("effect"),
			);
			const sqlPath = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
				import.meta.resolve("effect/unstable/sql"),
			);
			const write = (directory: string, name: string, body: string) =>
				fs.writeFileString(
					`${directory}/${name}`,
					`import{Effect}from ${effectPath};import{SqlClient}from ${sqlPath};export default Effect.gen(function*(){const sql=yield*SqlClient.SqlClient;${body}});`,
				);
			const initial = `${root}/initial`;
			yield* fs.makeDirectory(initial);
			yield* write(initial, "001_create.ts", "yield*sql`CREATE TABLE product(value TEXT)`;");
			yield* migrate(initial, "current");
			const ledger = yield* sql`SELECT * FROM migrations`;
			const receipts = yield* sql`SELECT * FROM extension_migrations ORDER BY name`;
			const identity = yield* sql`SELECT * FROM store_identity`;
			const statements = [
				"DROP TABLE store_identity",
				"CREATE TEMP TRIGGER injected AFTER INSERT ON outbox BEGIN DELETE FROM mutation_batches; END",
				"CREATE TEMP TABLE OuTbOx(value TEXT)",
				"CREATE TEMP VIEW kernel_writer AS SELECT 1 AS singleton, 'changed' AS epoch",
				"UPDATE store_identity SET store_id='lost'",
				"ALTER TABLE outbox ADD COLUMN extra TEXT",
				"DELETE FROM protected_sql_tables",
				"DELETE FROM extension_migrations",
				"DELETE FROM migrations",
				"DELETE FROM mutation_batches",
				"DELETE FROM outbox",
			];
			for (const [index, statement] of statements.entries()) {
				assert.equal((yield* extension(`bad-${index}`, statement).pipe(Effect.exit))._tag, "Failure");
				const directory = `${root}/bad-${index}`;
				yield* fs.makeDirectory(directory);
				yield* write(directory, "002_first.ts", "yield*sql`INSERT INTO product VALUES('must roll back')`;");
				yield* write(directory, "003_bad.ts", `yield*sql.unsafe(${JSON.stringify(statement)});`);
				assert.equal((yield* migrate(directory, "current").pipe(Effect.exit))._tag, "Failure");
				assert.deepEqual(yield* sql`SELECT * FROM migrations`, ledger);
				assert.deepEqual(yield* sql`SELECT * FROM extension_migrations ORDER BY name`, receipts);
				assert.deepEqual(yield* sql`SELECT * FROM product`, []);
				assert.deepEqual(yield* sql`SELECT * FROM store_identity`, identity);
				assert.deepEqual(yield* sql`SELECT * FROM outbox`, [{ seq: 42, event: "retained-event" }]);
				assert.deepEqual(yield* sql`SELECT * FROM mutation_batches`, [{ id: "retained-batch", count: 1 }]);
				assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables`, [{ name: "owned" }]);
			}
			// Catching the caller's successful DROP cannot hide the violated postcondition.
			const swallowed = `${root}/swallowed`;
			yield* fs.makeDirectory(swallowed);
			yield* write(
				swallowed,
				"002_drop.ts",
				"yield*sql`DROP TABLE store_identity`.pipe(Effect.catch(()=>Effect.void));",
			);
			assert.equal((yield* migrate(swallowed, "current").pipe(Effect.exit))._tag, "Failure");
			assert.deepEqual(yield* sql`SELECT * FROM store_identity`, identity);
			const good = `${root}/good`;
			yield* fs.makeDirectory(good);
			yield* write(
				good,
				"002_upgrade.ts",
				"yield*sql`ALTER TABLE owned ADD COLUMN later INTEGER`;yield*sql`INSERT INTO product VALUES('accepted')`;",
			);
			assert.deepEqual(yield* migrate(good, "current"), [[2, "upgrade"]]);
			assert.deepEqual(yield* migrate(good, "current"), []);
			assert.deepEqual(yield* sql`SELECT * FROM product`, [{ value: "accepted" }]);
			assert.deepEqual(yield* sql`SELECT * FROM owned`, [{ value: "retained", extra: "valid upgrade", later: null }]);
			assert.deepEqual(yield* sql`SELECT name FROM temp.sqlite_schema WHERE type='trigger'`, []);
			console.log("MIGRATION_STATE_PRESERVED");
		}),
	).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.provide(BunServices.layer)),
);
