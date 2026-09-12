import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { KernelError } from "../../src/kernel/boot-channel.ts";
import { makeExtensionMigrate } from "../../src/kernel/extension-migrations.ts";

const run = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.makeTempDirectoryScoped();
	yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT)`;
		yield* sql`INSERT INTO kernel_writer VALUES(1,'current')`;
		const migrate = yield* makeExtensionMigrate(sql, "current", "example");
		const create = "CREATE TABLE example_data(value TEXT)";
		yield* migrate("001-create", create, { protect: true });
		yield* migrate("001-create", create, { protect: true });
		assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables`, [{ name: "example_data" }]);
		assert.deepEqual(yield* sql`SELECT extension,name,length(checksum) AS size FROM extension_migrations`, [
			{ extension: "example", name: "001-create", size: 64 },
		]);
		const errorCode = (error: unknown) => (Schema.is(KernelError)(error) ? error.code : "unexpected_failure");
		// A replay cannot adopt an old unprotected table, even when protection is newly requested.
		const unprotected = "CREATE TABLE legacy_data(value TEXT)";
		yield* migrate("legacy", unprotected);
		const receipts = yield* sql`SELECT * FROM extension_migrations ORDER BY name`;
		yield* migrate("legacy", unprotected, { protect: true });
		assert.deepEqual(yield* sql`SELECT * FROM extension_migrations ORDER BY name`, receipts);
		assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables WHERE name='legacy_data'`, []);
		yield* sql`INSERT INTO legacy_data VALUES('still writable')`;
		// SQLite identifiers are case-insensitive. Neither spelling can adopt an existing core table.
		yield* sql`CREATE TABLE messages(body TEXT)`;
		yield* sql`INSERT INTO messages VALUES('preserved')`;
		for (const name of ["messages", "MeSsAgEs"]) {
			assert.equal(
				errorCode(
					yield* migrate(`adopt-${name}`, `CREATE TABLE IF NOT EXISTS ${name}(body TEXT)`, { protect: true }).pipe(
						Effect.flip,
					),
				),
				"extension_migration_invalid",
			);
		}
		assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables WHERE name='messages'`, []);
		assert.deepEqual(yield* sql`SELECT name FROM extension_migrations WHERE name LIKE 'adopt-%'`, []);
		assert.deepEqual(yield* sql`SELECT body FROM messages`, [{ body: "preserved" }]);
		yield* migrate("mixed-new", "CREATE TABLE MiXeD_new(value TEXT)", { protect: true });
		assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables WHERE name='mixed_new'`, [{ name: "mixed_new" }]);
		const insert = "INSERT INTO example_data VALUES('once')";
		yield* Effect.all([migrate("002-insert", insert), migrate("002-insert", insert)], { concurrency: 2 });
		assert.deepEqual(yield* sql`SELECT value FROM example_data`, [{ value: "once" }]);
		assert.equal(
			errorCode(yield* migrate("002-insert", "INSERT INTO example_data VALUES('changed')").pipe(Effect.flip)),
			"extension_migration_conflict",
		);
		const second = yield* makeExtensionMigrate(sql, "current", "second");
		yield* second("002-insert", insert);
		assert.deepEqual(yield* sql`SELECT value FROM example_data`, [{ value: "once" }, { value: "once" }]);

		// A failed receipt insert must roll back even DDL that has already executed.
		yield* sql`CREATE TRIGGER reject_migration BEFORE INSERT ON extension_migrations WHEN NEW.name='003-atomic' BEGIN SELECT RAISE(ABORT,'test receipt failure'); END`;
		assert.equal(
			(yield* migrate("003-atomic", "CREATE TABLE rolled_back(value TEXT)", { protect: true }).pipe(Effect.exit))._tag,
			"Failure",
		);
		assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE name='rolled_back'`, []);
		assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables WHERE name='rolled_back'`, []);
		assert.deepEqual(yield* sql`SELECT name FROM extension_migrations WHERE name='003-atomic'`, []);
		yield* sql`DROP TRIGGER reject_migration`;
		yield* migrate("003-atomic", "CREATE TABLE rolled_back(value TEXT)");
		assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE name='rolled_back'`, [{ name: "rolled_back" }]);

		assert.equal(
			(yield* migrate("004-repair", "INSERT INTO missing_table VALUES(1)").pipe(Effect.exit))._tag,
			"Failure",
		);
		yield* migrate("004-repair", "INSERT INTO example_data VALUES('repaired')");
		for (const statement of [
			"CREATE TABLE partial(value TEXT); DROP TABLE example_data",
			"COMMIT",
			"PRAGMA user_version=9",
			"--comment\nDELETE FROM example_data",
			"INSERT INTO example_data VALUES('nul\u0000')",
		]) {
			assert.equal(errorCode(yield* migrate("rejected", statement).pipe(Effect.flip)), "extension_migration_invalid");
		}
		assert.equal(errorCode(yield* migrate("", create).pipe(Effect.flip)), "extension_migration_invalid");
		for (const statement of [
			'CREATE TABLE "quoted"(value TEXT)',
			"CREATE TABLE main.qualified(value TEXT)",
			"ALTER TABLE example_data ADD COLUMN other TEXT",
		]) {
			assert.equal(
				errorCode(yield* migrate("protected-invalid", statement, { protect: true }).pipe(Effect.flip)),
				"extension_migration_invalid",
			);
		}
		yield* sql`UPDATE kernel_writer SET epoch='replacement'`;
		assert.equal(errorCode(yield* migrate("001-create", create, { protect: true }).pipe(Effect.flip)), "stale_writer");
		assert.equal(
			errorCode(yield* migrate("005-stale", "CREATE TABLE forbidden(value TEXT)").pipe(Effect.flip)),
			"stale_writer",
		);
		assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE name IN ('forbidden','partial')`, []);
		assert.deepEqual(yield* sql`SELECT value FROM example_data`, [
			{ value: "once" },
			{ value: "once" },
			{ value: "repaired" },
		]);
		yield* Console.log("EXTENSION_MIGRATIONS_ATOMIC");
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/app.db` })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
run.pipe(BunRuntime.runMain);
