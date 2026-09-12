import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { guardianClientLayer } from "@comms/storage/remote-client";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { resolveRestoreTarget } from "../../src/database-restore-auth.ts";
import { AuthError } from "../../src/auth.ts";

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
					};
					// This SQL-layout fixture has no external owner; use production codecs/leases.
					return guardianClientLayer({
						connection: { ...config, engine, tls: false },
						attempt: "a".repeat(64),
						register: () => Effect.void,
					});
				});
	yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`CREATE TEMPORARY TABLE backups(id VARCHAR(128),published_through INTEGER,engine VARCHAR(16))`;
				yield* sql`CREATE TEMPORARY TABLE generations(n INTEGER,good INTEGER,snapshot_dir TEXT,backup_id VARCHAR(128))`;
				for (const catalogEngine of ["sqlite", "pg", "mysql"]) {
					yield* sql`INSERT INTO backups VALUES(${catalogEngine},42,${catalogEngine})`;
					const result = yield* resolveRestoreTarget({ backup: catalogEngine }).pipe(Effect.result);
					if (catalogEngine === engine) {
						assert.equal(result._tag, "Success");
						if (result._tag === "Success")
							assert.deepEqual(result.success, { backup: catalogEngine, published_through: 42 });
					} else {
						assert.equal(result._tag, "Failure");
						if (result._tag === "Failure") {
							assert.equal(Schema.is(AuthError)(result.failure), true);
							if (Schema.is(AuthError)(result.failure)) assert.equal(result.failure.code, "backup_engine_mismatch");
						}
					}
				}
				yield* sql`INSERT INTO generations VALUES(1,1,'/snapshot',${engine})`;
				assert.deepEqual(yield* resolveRestoreTarget({ generation: 1, withDb: true }), {
					backup: engine,
					published_through: 42,
				});
			}),
		);
	}).pipe(Effect.provide(layer));
	return { engine, passed: true };
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(
	Effect.flatMap((value) => Console.log(JSON.stringify(value))),
	BunRuntime.runMain,
);
