import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrate } from "../../src/kernel/migrations.ts";
const run = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.makeTempDirectoryScoped();
	let directory = `${root}/migrations`;
	yield* fs.makeDirectory(directory);
	const header = `import { Effect } from ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(import.meta.resolve("effect"))};\nimport { SqlClient } from ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(import.meta.resolve("effect/unstable/sql"))};\nexport default Effect.gen(function* () { const sql = yield* SqlClient.SqlClient;\n`;
	const write = (name: string, body: string) => fs.writeFileString(`${directory}/${name}`, `${header}${body}\n});`);
	yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT)`;
		yield* sql`INSERT INTO kernel_writer VALUES(1,'current')`;
		yield* write("002_insert.ts", "yield* sql`INSERT INTO example VALUES('one; two')`; ");
		yield* write("001-create.ts", "yield* sql`CREATE TABLE example(value TEXT)`; ");
		assert.deepEqual(yield* migrate(directory, "current"), [
			[1, "create"],
			[2, "insert"],
		]);
		assert.deepEqual(yield* sql`SELECT value FROM example`, [{ value: "one; two" }]);
		assert.deepEqual(yield* migrate(directory, "current"), []);
		directory = `${root}/next`;
		yield* fs.makeDirectory(directory);
		yield* write("003_next.ts", "yield* sql`CREATE TABLE rolled_back(id INTEGER)`; ");
		yield* write(
			"004_fail.ts",
			"yield* sql`INSERT INTO example VALUES('discard')`; yield* sql`INSERT INTO missing_table VALUES(1)`;",
		);
		assert.equal((yield* migrate(directory, "current").pipe(Effect.exit))._tag, "Failure");
		assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE name='rolled_back'`, []);
		assert.deepEqual(yield* sql`SELECT value FROM example`, [{ value: "one; two" }]);
		assert.deepEqual(yield* sql`SELECT migration_id FROM migrations ORDER BY migration_id`, [
			{ migration_id: 1 },
			{ migration_id: 2 },
		]);
		directory = `${root}/fixed`;
		yield* fs.makeDirectory(directory);
		yield* write("003_next.ts", "yield* sql`CREATE TABLE rolled_back(id INTEGER)`;");
		yield* write("004_fixed.ts", "yield* sql`INSERT INTO example VALUES('fixed')`; ");
		assert.deepEqual(yield* migrate(directory, "current"), [
			[3, "next"],
			[4, "fixed"],
		]);
		yield* write("004-duplicate.ts", "return;");
		assert.equal((yield* migrate(directory, "current").pipe(Effect.exit))._tag, "Failure");
		yield* fs.remove(`${directory}/004-duplicate.ts`);
		yield* write("005_stale.ts", "yield* sql`CREATE TABLE forbidden(id INTEGER)`;");
		assert.equal((yield* migrate(directory, "old").pipe(Effect.exit))._tag, "Failure");
		assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE name='forbidden'`, []);
		yield* fs.remove(`${directory}/005_stale.ts`);
		yield* write("000_zero.ts", "return;");
		assert.equal((yield* migrate(directory, "current").pipe(Effect.exit))._tag, "Failure");
		directory = `${root}/invalid`;
		yield* fs.makeDirectory(directory);
		yield* fs.writeFileString(`${directory}/006_invalid.ts`, "export default 42;");
		assert.equal((yield* migrate(directory, "current").pipe(Effect.exit))._tag, "Failure");
		assert.deepEqual(yield* sql`SELECT migration_id FROM migrations ORDER BY migration_id`, [
			{ migration_id: 1 },
			{ migration_id: 2 },
			{ migration_id: 3 },
			{ migration_id: 4 },
		]);
		yield* Console.log("MIGRATIONS_ATOMIC");
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/app.db` })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
run.pipe(BunRuntime.runMain);
