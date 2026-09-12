import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { Effect, Redacted, Schema } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { open } from "../../src/remote-driver.ts";
import { on } from "../../src/dialect.ts";
import { remoteMigrate, tableShape, indexShape } from "../../src/remote-migrations.ts";
const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const filename = process.env.COMMS_REMOTE_MIGRATION_TEST_CONFIG;
if (!filename) throw new Error("Missing disposable schema configuration");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
if (!settings.database.startsWith("comms_schema_runner"))
	throw new Error("Requires disposable migration test database");
const mode = process.argv[2];
async function main() {
	let phase = "connect";
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* open(
					{ ...settings, password: Redacted.make(settings.password), tls: false },
					"comms-migration-test",
				);
				const shape = tableShape(
					sql,
					"migration_probe",
					[
						{ name: "id", type: settings.engine === "pg" ? "integer" : "int", nullable: false },
						{ name: "body", type: settings.engine === "pg" ? "text" : "longtext", nullable: false },
					],
					["id"],
				);
				const steps = [
					{
						id: 1,
						name: "probe",
						operations: [
							{
								name: "table",
								postcondition: shape,
								run: Effect.gen(function* () {
									yield* on(sql, {
										sqlite: () => sql`SELECT 1`,
										pg: () => sql`CREATE TABLE migration_probe(id integer PRIMARY KEY,body text NOT NULL)`,
										mysql: () =>
											sql`CREATE TABLE migration_probe(id integer PRIMARY KEY,body longtext NOT NULL) ENGINE=InnoDB`,
									});
									if (mode === "crash") {
										yield* Effect.sync(() => process.stdout.write("DDL_APPLIED\n"));
										yield* Effect.never;
									}
								}),
							},
							{
								name: "index",
								postcondition: indexShape(sql, "migration_probe", "migration_probe_id", ["id"], true),
								run: sql`CREATE UNIQUE INDEX migration_probe_id ON migration_probe(id)`.pipe(Effect.asVoid),
							},
						],
					},
				];
				if (mode === "reset") {
					for (const name of ["migration_probe", "boot_migrations_intent", "boot_migrations"])
						yield* sql`DROP TABLE IF EXISTS ${sql(name)}`;
					return;
				}
				if (mode === "unsafe-index") {
					const first = steps[0]?.operations[0];
					assert(first);
					yield* first.run;
					yield* on(sql, {
						sqlite: () => sql`SELECT 1`,
						pg: () => sql`CREATE UNIQUE INDEX migration_probe_id ON migration_probe(id,lower(body))`,
						mysql: () => sql`CREATE UNIQUE INDEX migration_probe_id ON migration_probe(body(5))`,
					});
					const result = yield* indexShape(
						sql,
						"migration_probe",
						"migration_probe_id",
						[settings.engine === "pg" ? "id" : "body"],
						true,
					).pipe(Effect.result);
					assert.equal(result._tag, "Failure");
					return;
				}
				phase = "migrate";
				if (mode === "malformed") {
					if (settings.engine !== "mysql") throw new Error("MySQL fixture required");
					yield* on(sql, {
						sqlite: () => sql`SELECT 1`,
						pg: () => sql`SELECT 1`,
						mysql: () =>
							sql`CREATE TABLE boot_migrations_intent(singleton integer,migration_id integer,name varchar(255),operation integer,active varchar(255)) ENGINE=MyISAM`,
					});
					const result = yield* remoteMigrate(sql, "boot_migrations", steps).pipe(Effect.result);
					assert.equal(result._tag, "Failure");
					assert.equal(yield* shape, false);
					return;
				}
				yield* remoteMigrate(sql, "boot_migrations", steps);
				phase = "retained-write";
				const before = yield* sql`SELECT id,body FROM migration_probe ORDER BY id`;
				if (before.length === 0) yield* sql`INSERT INTO migration_probe(id,body) VALUES(1,'retained after DDL')`;
				yield* remoteMigrate(sql, "boot_migrations", steps);
				assert.deepEqual(yield* sql`SELECT id,body FROM migration_probe ORDER BY id`, [
					{ id: 1, body: "retained after DDL" },
				]);
				assert.deepEqual(yield* sql`SELECT migration_id,name FROM boot_migrations`, [
					{ migration_id: 1, name: "probe" },
				]);
				if (settings.engine === "mysql") assert.deepEqual(yield* sql`SELECT * FROM boot_migrations_intent`, []);
				process.stdout.write("MIGRATION_VERIFIED\n");
			}),
		).pipe(Effect.provide(Reactivity.layer)),
	).catch(() => {
		throw new Error(`Migration fixture failed at ${phase}`);
	});
}
await main();
