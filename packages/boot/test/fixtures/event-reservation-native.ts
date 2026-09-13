import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { advisoryClientLayer } from "@comms/storage/remote-client";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Events, eventsSchema, layer as eventsLayer } from "../../src/events.ts";
import { eventTables } from "../../src/boot-event-tables.ts";

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
					return advisoryClientLayer({
						connection: { ...config, engine, tls: false },
					});
				});
	yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql.withTransaction(
			Effect.gen(function* () {
				if (engine === "sqlite") {
					yield* eventsSchema;
					yield* sql`ALTER TABLE events ADD COLUMN topic TEXT`;
				} else if (engine === "pg" || engine === "mysql") {
					for (const table of eventTables(sql, engine)) {
						const [ddl, parameters] = table.run.compile();
						assert.equal(parameters.length, 0);
						yield* sql.unsafe(ddl.replace("CREATE TABLE", "CREATE TEMPORARY TABLE"));
					}
					yield* sql`INSERT INTO seq (singleton,${sql("next")},published_through) VALUES(1,1,0)`;
				}
				yield* Effect.gen(function* () {
					const events = yield* Events;
					const reserved = yield* events.reserveStartup("probe-reservation", 1, "attempt");
					assert.deepEqual(reserved, { transaction: "probe-reservation", from: 1, to: 1 });
					assert.deepEqual(yield* events.reserveStartup("probe-reservation", 1, "attempt"), reserved);
					assert.deepEqual(yield* sql`SELECT id,attempt,from_seq,to_seq,state FROM event_batches`, [
						{ id: "probe-reservation", attempt: "attempt", from_seq: 1, to_seq: 1, state: "pending" },
					]);
					yield* events.abort("probe-reservation", "attempt");
					assert.equal((yield* events.state).pending_id, null);
					assert.deepEqual(yield* sql`SELECT state FROM event_batches`, [{ state: "aborted" }]);
				}).pipe(Effect.provide(eventsLayer(Effect.void)));
			}),
		);
	}).pipe(Effect.provide(layer));
	return { engine, passed: true };
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(
	Effect.flatMap((value) => Console.log(JSON.stringify(value))),
	BunRuntime.runMain,
);
