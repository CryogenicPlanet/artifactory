import { strict as assert } from "node:assert";
import { BunServices } from "@effect/platform-bun";
import { Crypto, Effect, FileSystem, Layer, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { testStore } from "./test-store.ts";
import { makeExtensionMigrate } from "../../src/kernel/extension-migrations.ts";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
import { migrateProtectionOwnership, protectionOwnershipOperation } from "../../src/kernel/protection-schema.ts";
import { migrate } from "../../src/kernel/migrations.ts";
const engine = Schema.decodeUnknownSync(Schema.Literals(["sqlite", "pglite", "pg", "mysql"]))(process.argv[2]);
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* testStore({
			engine,
			config: process.env.COMMS_PROTECTION_CONFIG,
			database: process.env.COMMS_PROTECTION_DATABASE ?? "unused",
			tables: [],
		});
		yield* Effect.gen(function* () {
			yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch VARCHAR(64) NOT NULL)`;
			yield* sql`INSERT INTO kernel_writer VALUES(1,'current')`;
			if (engine === "mysql")
				yield* sql`CREATE TABLE kernel_migration_intent(singleton INTEGER PRIMARY KEY CHECK(singleton=1),scope VARCHAR(255) NOT NULL,name VARCHAR(255) NOT NULL,epoch VARCHAR(128) NOT NULL) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`;
			yield* initializeRemoteKernelSchema(sql, "current");
			if (engine === "sqlite") yield* sql`CREATE TABLE protected_sql_tables(name TEXT PRIMARY KEY COLLATE NOCASE)`;
			yield* sql`INSERT INTO protected_sql_tables(name) VALUES('legacy')`;
			yield* sql`CREATE TABLE legacy(value INTEGER)`;
			if (engine === "sqlite") yield* migrateProtectionOwnership(sql);
			else {
				const operation = protectionOwnershipOperation(sql);
				assert.equal(yield* operation.postcondition, false);
				yield* operation.run;
				assert.equal(yield* operation.postcondition, true);
			}
			assert.deepEqual(yield* sql`SELECT extension,migration FROM protected_sql_tables WHERE name='legacy'`, [
				{ extension: null, migration: null },
			]);
			const owner = yield* makeExtensionMigrate(sql, "current", "owner");
			const other = yield* makeExtensionMigrate(sql, "current", "other");
			const crypto = yield* Crypto.Crypto;
			yield* sql`CREATE TABLE IF NOT EXISTS extension_migrations(extension VARCHAR(255) NOT NULL,name VARCHAR(128) NOT NULL,checksum VARCHAR(64) NOT NULL,PRIMARY KEY(extension,name))`;
			const historical = "CREATE TABLE IF NOT EXISTS legacy(value INTEGER)";
			const checksum = Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(historical))).toString(
				"hex",
			);
			// Historical receipts cannot prove which extension created a protected table.
			yield* sql`INSERT INTO extension_migrations(extension,name,checksum) VALUES('other','historical',${checksum})`;
			yield* other("historical", historical, { protect: true });
			assert.deepEqual(yield* sql`SELECT extension,migration FROM protected_sql_tables WHERE name='legacy'`, [
				{ extension: null, migration: null },
			]);
			assert.equal((yield* other("historical", historical, { unprotect: "legacy" }).pipe(Effect.exit))._tag, "Failure");
			const create = "CREATE TABLE owned(value INTEGER)";
			yield* owner("create", create, { protect: true });
			assert.deepEqual(yield* sql`SELECT extension,migration FROM protected_sql_tables WHERE name='owned'`, [
				{ extension: "owner", migration: "create" },
			]);
			yield* owner("seed", "INSERT INTO owned VALUES(7)");
			yield* other("ordinary", "CREATE TABLE ordinary(value INTEGER)");
			yield* sql`INSERT INTO protected_sql_tables(name) VALUES('absent_protected')`;
			for (const clause of ["TO", "AS", ""]) {
				assert.equal(
					(yield* other(`absent-${clause}`, `ALTER TABLE ordinary RENAME ${clause} absent_protected`).pipe(Effect.exit))
						._tag,
					"Failure",
				);
			}
			assert.deepEqual(yield* sql`SELECT value FROM ordinary`, []);
			for (const statement of [
				"DELETE FROM owned",
				"DROP TABLE ordinary, owned",
				"ALTER TABLE ordinary RENAME`absent_protected`",
				"ALTER TABLE ordinary ADD COLUMN extra INTEGER, RENAME TO absent_protected",
				"ALTER TABLE ordinary ADD COLUMN extra INTEGER, RENAME AS absent_protected",
				"DROP TABLE IF EXISTS ordinary, `owned`",
				"RENAME TABLE ordinary TO ordinary_renamed, owned TO stolen",
				"ALTER TABLE `owned` ADD COLUMN stolen INTEGER",
				"DROP TABLE owned",
				"ALTER TABLE owned RENAME TO stolen",
				"DELETE FROM protected_sql_tables",
			])
				assert.equal((yield* other(`refused-${statement}`, statement).pipe(Effect.exit))._tag, "Failure");
			assert.equal(
				(yield* other("release", "UPDATE owned SET value=value", { unprotect: "owned" }).pipe(Effect.exit))._tag,
				"Failure",
			);
			assert.equal(
				(yield* owner("legacy-release", "UPDATE legacy SET value=value", { unprotect: "legacy" }).pipe(Effect.exit))
					._tag,
				"Failure",
			);
			assert.deepEqual(yield* sql`SELECT value FROM owned`, [{ value: 7 }]);
			yield* owner("rename", "ALTER TABLE owned RENAME TO renamed");
			yield* owner("rename", "ALTER TABLE owned RENAME TO renamed");
			assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables WHERE extension='owner'`, [
				{ name: "renamed" },
			]);
			assert.equal((yield* other("renamed-delete", "DELETE FROM renamed").pipe(Effect.exit))._tag, "Failure");
			yield* owner("retire", "UPDATE renamed SET value=value", { unprotect: "renamed" });
			yield* owner("retire", "UPDATE renamed SET value=value", { unprotect: "renamed" });
			assert.equal((yield* owner("retire", "UPDATE renamed SET value=value").pipe(Effect.exit))._tag, "Failure");
			yield* other("released-write", "UPDATE renamed SET value=8");
			yield* owner("disposable", "CREATE TABLE disposable(value INTEGER)", { protect: true });
			yield* owner("drop", "DROP TABLE disposable");
			assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables WHERE extension='owner'`, []);
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const effectPath = JSON.stringify(import.meta.resolve("effect"));
			const module = (unprotect: readonly string[], body = "Effect.void") =>
				`import {Effect} from ${effectPath}; export const unprotect = ${JSON.stringify(unprotect)}; export default ${body};`;
			yield* fs.writeFileString(`${directory}/001_release.ts`, module(["legacy"]));
			yield* migrate(directory, "current");
			assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables WHERE name='legacy'`, []);
			yield* owner("retained", "CREATE TABLE retained(value INTEGER)", { protect: true });
			// A new directory defeats import caching: applied IDs still never import or execute changed declarations.
			const changed = yield* fs.makeTempDirectoryScoped();
			yield* fs.writeFileString(`${changed}/001_release.ts`, module(["retained"], 'Effect.die("must not execute")'));
			assert.deepEqual(yield* migrate(changed, "current"), []);
			assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables WHERE name='retained'`, [{ name: "retained" }]);
			yield* fs.writeFileString(`${changed}/002_intrinsic.ts`, module(["outbox"]));
			assert.equal((yield* migrate(changed, "current").pipe(Effect.exit))._tag, "Failure");
			assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables WHERE name='retained'`, [{ name: "retained" }]);
		}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
	}).pipe(Effect.provide(Layer.merge(BunServices.layer, Reactivity.layer)), Effect.scoped),
);
console.log("PROTECTION_LIFECYCLE_VERIFIED");
