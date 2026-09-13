import { readFile } from "node:fs/promises";
import { Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { advisoryClientLayer } from "@comms/storage/remote-client";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const filename = process.env.COMMS_REMOTE_SQL_READ_TEST_CONFIG;
if (!filename) throw new Error("Missing disposable remote reader configuration");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
if (settings.database !== "comms_schema_query") throw new Error("Requires isolated query database");
let phase = "connect";
await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			phase = "drop-function";
			yield* sql.unsafe(
				settings.engine === "pg"
					? "DROP FUNCTION IF EXISTS reader_write_probe()"
					: "DROP FUNCTION IF EXISTS reader_write_probe",
			).unprepared;
			phase = "drop-table";
			yield* sql`DROP TABLE IF EXISTS reader_write_probe_rows`;
			if (process.argv[2] === "cleanup") return;
			phase = "create-table";
			yield* sql`CREATE TABLE reader_write_probe_rows(value INTEGER NOT NULL)`;
			phase = "seed";
			yield* sql`INSERT INTO reader_write_probe_rows VALUES(0)`;
			phase = "create-function";
			yield* sql.unsafe(
				settings.engine === "pg"
					? "CREATE FUNCTION reader_write_probe() RETURNS INTEGER LANGUAGE plpgsql VOLATILE AS $$ BEGIN UPDATE reader_write_probe_rows SET value=1; RETURN 1; END $$"
					: "CREATE FUNCTION reader_write_probe() RETURNS INTEGER MODIFIES SQL DATA SQL SECURITY INVOKER BEGIN UPDATE reader_write_probe_rows SET value=1; RETURN 1; END",
			).unprepared;
		}),
	).pipe(
		Effect.provide(
			advisoryClientLayer({
				connection: { ...settings, password: Redacted.make(settings.password), tls: false },
			}),
		),
	),
).catch(() => {
	throw new Error(`Remote reader fixture setup failed at ${phase}`);
});
