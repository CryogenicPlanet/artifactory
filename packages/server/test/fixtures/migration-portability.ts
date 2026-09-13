import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Cause, ConfigProvider, Console, Effect, Exit, FileSystem, Layer } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";
import { layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";
import { layer as warningLayer, MigrationWarnings } from "../../src/kernel/migration-portability.ts";
import { migrate } from "../../src/kernel/migrations.ts";

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.makeTempDirectoryScoped();
	let directory = root;
	const warnings = yield* MigrationWarnings;
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT)`;
	yield* sql`INSERT INTO kernel_writer VALUES(1,'current')`;
	const header = `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { Migrator, SqlClient } from ${JSON.stringify(import.meta.resolve("effect/unstable/sql"))};
import { greatest } from ${JSON.stringify(import.meta.resolve("@comms/storage/dialect"))};
export default Effect.gen(function* () { const sql = yield* SqlClient.SqlClient;`;
	const write = (name: string, body: string) => fs.writeFileString(`${directory}/${name}`, `${header}\n${body}\n});`);
	yield* write("001_plain.ts", "yield* sql`CREATE TABLE example(value INTEGER)`;");
	yield* write("002_helper.ts", "yield* sql`INSERT INTO example VALUES (${greatest(sql,1,2)})`;");
	yield* write(
		"003_branch.ts",
		"yield* sql.onDialectOrElse({sqlite:()=>sql`INSERT INTO example VALUES(3)`,orElse:()=>Effect.void});",
	);
	yield* write("004_plain_again.ts", "yield* sql`INSERT INTO example VALUES(4)`;");
	yield* write("005_safe.ts", "yield* sql.safe.onDialectOrElse({sqlite:()=>sql`SELECT 1`,orElse:()=>Effect.void});");
	yield* write(
		"006_plain_client.ts",
		"yield* sql.withoutTransforms().onDialectOrElse({sqlite:()=>sql`SELECT 1`,orElse:()=>Effect.void});",
	);
	yield* migrate(root, "current");
	const expected = warnings.enabled
		? {
				warnings: {
					items: [
						{ code: "migration.non_portable", migration: "1_plain" },
						{ code: "migration.non_portable", migration: "4_plain_again" },
					],
					overflow: 0,
				},
			}
		: {};
	assert.deepEqual(yield* warnings.report, expected);
	yield* migrate(root, "current");
	assert.deepEqual(yield* warnings.report, expected);
	// Use a fresh import directory so Bun does not reuse the earlier directory-resolution cache.
	directory = `${root}/pending`;
	yield* fs.makeDirectory(directory);
	yield* write("007_rollback.ts", "yield* sql`INSERT INTO example VALUES(5)`;");
	yield* write("008_fail.ts", "yield* sql`INSERT INTO missing_table VALUES(6)`;");
	const failed = yield* migrate(directory, "current").pipe(Effect.exit);
	assert.ok(Exit.isFailure(failed));
	const cause = Cause.squash(failed.cause);
	assert.ok(cause instanceof Migrator.MigrationError);
	assert.equal(cause.kind, "Failed");
	assert.equal(cause.message, 'Migration "8_fail" failed');
	assert.deepEqual(yield* warnings.report, expected);
	assert.deepEqual(yield* sql`SELECT value FROM example ORDER BY value`, [{ value: 2 }, { value: 3 }, { value: 4 }]);
	assert.deepEqual(yield* sql`SELECT migration_id FROM migrations ORDER BY migration_id`, [
		{ migration_id: 1 },
		{ migration_id: 2 },
		{ migration_id: 3 },
		{ migration_id: 4 },
		{ migration_id: 5 },
		{ migration_id: 6 },
	]);
	yield* Console.log("MIGRATION_ADVISORIES_VERIFIED");
}).pipe(
	Effect.provide(SqliteClient.layer({ filename: ":memory:", transformResultNames: (name) => name })),
	Effect.provide(warningLayer.pipe(Layer.provide(lifecycleLayer))),
	Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ STATE: process.argv[2] })),
	Effect.scoped,
	Effect.provide(BunServices.layer),
);
main.pipe(BunRuntime.runMain);
