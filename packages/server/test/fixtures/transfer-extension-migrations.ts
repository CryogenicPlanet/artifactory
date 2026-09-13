import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { memoryStoreLayer } from "./test-store.ts";
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
			return yield* transferExtensionMigrations(sql, "offline", directory, "pg").pipe(Effect.result);
		});
	const registration = `export default api => {
	const forbidden = () => { throw new Error("Handler executed"); };
	api.route("GET", "/fixture", { handler: forbidden }); api.mount({}, forbidden);
	api.page("/fixture", forbidden); api.cron("* * * * *", forbidden); api.on("start", forbidden);
	return api.migrate("create", "CREATE TABLE extension_data(value TEXT)", { protect: true });
	}`;
	const good = yield* run("good", registration);
	assert.equal(good._tag, "Success");
	const hash = (text: string) => createHash("sha256").update(text).digest("hex");
	if (good._tag === "Success")
		assert.deepEqual(good.success, [
			{
				extension: "example.ts",
				name: "create",
				sourceChecksum: hash(JSON.stringify(["CREATE TABLE extension_data(value TEXT)", true, null])),
				sourceLegacyChecksum: hash("CREATE TABLE extension_data(value TEXT)"),
				targetChecksum: hash(JSON.stringify(["CREATE TABLE extension_data(value TEXT)", true, null])),
				targetLegacyChecksum: hash("CREATE TABLE extension_data(value TEXT)"),
			},
		]);
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
	const portable = yield* run(
		"portable",
		`export default api => api.migrate("portable", {sqlite: "CREATE TABLE portable_data(value TEXT)", pg: "CREATE TABLE portable_data(value VARCHAR(32))", mysql: "CREATE TABLE portable_data(value LONGTEXT)"})`,
	);
	assert.equal(portable._tag, "Success");
	if (portable._tag === "Success")
		assert.deepEqual(portable.success, [
			{
				extension: "example.ts",
				name: "portable",
				sourceChecksum: hash(JSON.stringify(["CREATE TABLE portable_data(value VARCHAR(32))", false, null])),
				sourceLegacyChecksum: hash("CREATE TABLE portable_data(value VARCHAR(32))"),
				targetChecksum: hash(JSON.stringify(["CREATE TABLE portable_data(value TEXT)", false, null])),
				targetLegacyChecksum: hash("CREATE TABLE portable_data(value TEXT)"),
			},
		]);
	const duplicate = yield* run(
		"duplicate",
		`import { Effect } from "${import.meta.resolve("effect")}"; export default api => {
      return Effect.gen(function* () { yield* api.migrate("portable", {sqlite: "CREATE TABLE portable_data(value TEXT)", pg: "CREATE TABLE portable_data(value VARCHAR(32))", mysql: "unused"});
      yield* api.migrate("portable", {sqlite: "CREATE TABLE portable_data(value TEXT)", pg: "CREATE TABLE portable_data(value VARCHAR(64))", mysql: "unused"}); });
    }`,
	);
	assert.equal(duplicate._tag, "Failure");

	const changedOptions = yield* run("changed-options", registration.replace("protect: true", "protect: false"));
	assert.equal(changedOptions._tag, "Failure");
	const legacy = hash("CREATE TABLE extension_data(value TEXT)");
	yield* sql`UPDATE extension_migrations SET checksum=${legacy} WHERE name='create'`;
	yield* sql`UPDATE protected_sql_tables SET extension=NULL,migration=NULL WHERE name='extension_data'`;
	yield* transferExtensionMigrations(sql, "offline", `${root}/good`);
	assert.deepEqual(yield* sql`SELECT checksum FROM extension_migrations WHERE name='create'`, [{ checksum: legacy }]);
	assert.deepEqual(yield* sql`SELECT extension,migration FROM protected_sql_tables WHERE name='extension_data'`, [
		{ extension: null, migration: null },
	]);

	assert.equal(
		(yield* run(
			"duplicate-options",
			`import { Effect } from "${import.meta.resolve("effect")}"; export default api => Effect.gen(function* () {
		yield* api.migrate("create", "CREATE TABLE extension_data(value TEXT)", {protect: false});
		yield* api.migrate("create", "CREATE TABLE extension_data(value TEXT)", {protect: true});
	});`,
		))._tag,
		"Failure",
	);

	const releaseSource = `import { Effect } from "${import.meta.resolve("effect")}"; export default api => Effect.gen(function* () {
		yield* api.migrate("create_release", "CREATE TABLE release_data(value TEXT)", {protect: true});
		yield* api.migrate("release", "UPDATE release_data SET value=value", {unprotect: "release_data"});
	});`;
	const release = yield* run("release", releaseSource);
	assert.equal(release._tag, "Success");
	if (release._tag === "Success") {
		const proof = release.success.find((row) => row.name === "release");
		assert(proof);
		assert.equal(proof.sourceLegacyChecksum, undefined);
		assert.equal(proof.targetLegacyChecksum, undefined);
		assert.equal(
			proof.targetChecksum,
			hash(JSON.stringify(["UPDATE release_data SET value=value", false, "release_data"])),
		);
	}
	yield* sql`UPDATE extension_migrations SET checksum=${hash("UPDATE release_data SET value=value")} WHERE name='release'`;
	assert.equal(
		(yield* transferExtensionMigrations(sql, "offline", `${root}/release`).pipe(Effect.result))._tag,
		"Failure",
	);

	yield* Console.log("TRANSFER_EXTENSION_REPLAY_VERIFIED");
}).pipe(Effect.scoped, Effect.provide(memoryStoreLayer()), Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
