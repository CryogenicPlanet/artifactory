import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Cause, Console, Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { transferExtensionMigrations } from "../../src/kernel/transfer-extension-migrations.ts";

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT)`;
	yield* sql`INSERT INTO kernel_writer VALUES(1,'offline')`;
	const run = (name: string, source: string) =>
		Effect.gen(function* () {
			const directory = `${root}/${name}`;
			yield* fs.makeDirectory(directory);
			yield* fs.writeFileString(`${directory}/example.ts`, source);
			return yield* transferExtensionMigrations(sql, "offline", directory).pipe(Effect.result);
		});
	const registration = `export default api => {
	const forbidden = () => { throw new Error("Handler executed"); };
	api.route("GET", "/fixture", { handler: forbidden }); api.mount({}, forbidden);
	api.page("/fixture", forbidden); api.cron("* * * * *", forbidden); api.on("start", forbidden);
	return api.migrate("create", "CREATE TABLE extension_data(value TEXT)", { protect: true });
	}`;
	assert.equal((yield* run("good", registration))._tag, "Success");
	yield* transferExtensionMigrations(sql, "offline", `${root}/good`);
	assert.equal((yield* sql`SELECT * FROM extension_migrations`).length, 1);
	assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables`, [{ name: "extension_data" }]);
	for (const [name, source] of [
		["context", `export default api => { try { api.context("read"); } catch {} }`],
		["effects", `export default api => { try { api.effects; } catch {} }`],
		["factory", `export default () => { throw new Error("private factory failure"); }`],
		["migration", `export default api => api.migrate("bad", "CREATE TABLE broken(")`],
	] as const) {
		const result = yield* run(name, source);
		assert.equal(result._tag, "Failure");
		if (result._tag === "Failure") {
			const text = Cause.pretty(Cause.fail(result.failure));
			assert.ok(text.includes("transfer_extension_failed"));
			assert.ok(!text.includes("private factory failure"));
		}
	}
	assert.equal((yield* sql`SELECT * FROM extension_migrations`).length, 1);
	assert.equal(
		(yield* run(
			"late",
			`export let late; export default api => { late = api.migrate("late", "CREATE TABLE late_data(value TEXT)"); }`,
		))._tag,
		"Success",
	);
	const imported: unknown = yield* Effect.tryPromise(() => import(`${root}/late/example.ts`));
	const saved = yield* Schema.decodeUnknownEffect(
		Schema.Struct({
			late: Schema.declare<Effect.Effect<unknown, unknown>>((value): value is Effect.Effect<unknown, unknown> =>
				Effect.isEffect(value),
			),
		}),
	)(imported);
	assert.equal((yield* saved.late.pipe(Effect.result))._tag, "Failure");
	assert.equal((yield* sql`SELECT name FROM sqlite_schema WHERE name='late_data'`).length, 0);
	yield* Console.log("TRANSFER_EXTENSION_REPLAY_VERIFIED");
}).pipe(Effect.scoped, Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
