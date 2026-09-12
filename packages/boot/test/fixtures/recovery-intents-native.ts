import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { recoveryIntents } from "../../src/recovery-intents.ts";

const Settings = Schema.Struct({
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const main = Effect.gen(function* () {
	const [engine, directory] = process.argv.slice(2);
	const layer =
		engine === "sqlite"
			? SqliteClient.layer({ filename: ":memory:" })
			: yield* Effect.gen(function* () {
					if (!directory || (engine !== "pg" && engine !== "mysql"))
						return yield* Effect.die("Missing native configuration");
					const settings = yield* (yield* FileSystem.FileSystem)
						.readFileString(`${directory}/${engine}-initialize-boot.json`)
						.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Settings))));
					if (settings.database !== "comms_initialize_boot") return yield* Effect.die("Refusing non-disposable store");
					const config = {
						host: settings.host,
						port: settings.port,
						database: settings.database,
						username: settings.username,
						password: Redacted.make(settings.password),
						maxConnections: 1,
					};
					return engine === "pg" ? PgClient.layer(config) : MysqlClient.layer(config);
				});
	yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`CREATE TEMPORARY TABLE cutover (marker INTEGER)`;
				yield* sql`CREATE TEMPORARY TABLE db_restore_requests (phase TEXT)`;
				yield* sql`CREATE TEMPORARY TABLE source_batches (state TEXT)`;
				assert.deepEqual(yield* recoveryIntents(sql), { cutover: 0, restore: 0, source: 0, count: 0 });
				yield* sql`INSERT INTO db_restore_requests VALUES('complete')`;
				yield* sql`INSERT INTO source_batches VALUES('committed')`;
				assert.deepEqual(yield* recoveryIntents(sql), { cutover: 0, restore: 0, source: 0, count: 0 });
				yield* sql`INSERT INTO cutover VALUES(1)`;
				assert.deepEqual(yield* recoveryIntents(sql), { cutover: 1, restore: 0, source: 0, count: 1 });
				yield* sql`INSERT INTO db_restore_requests VALUES('working')`;
				yield* sql`INSERT INTO source_batches VALUES('publishing')`;
				assert.deepEqual(yield* recoveryIntents(sql), { cutover: 1, restore: 1, source: 1, count: 3 });
			}),
		);
	}).pipe(Effect.provide(layer));
	return { engine, passed: true };
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(
	Effect.flatMap((value) => Console.log(JSON.stringify(value))),
	BunRuntime.runMain,
);
