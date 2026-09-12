import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { guardianClientLayer } from "@comms/storage/remote-client";
import { Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { remoteDatabaseJournal, RemoteDatabaseError } from "../../src/remote-database-journal.ts";
import { readSettings, readStoragePolicy, readPublicPaths } from "../../src/settings-schema.ts";
import { parseDescriptor } from "@comms/storage/store";

const Settings = Schema.Struct({
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const main = Effect.gen(function* () {
	const [engine, directory] = process.argv.slice(2);
	const layer = yield* Effect.gen(function* () {
		if (!directory || (engine !== "pg" && engine !== "mysql")) return yield* Effect.die("Missing native configuration");
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
				yield* sql`CREATE TEMPORARY TABLE settings(${sql("key")} VARCHAR(512) PRIMARY KEY,value TEXT)`;
				const storage = { backup_percent: 25, event_percent: 15, headroom_percent: 10 };
				assert.equal((yield* readStoragePolicy).backup_percent, 20);
				assert.deepEqual(yield* readPublicPaths, []);
				yield* sql`INSERT INTO settings VALUES ('storage_policy',${JSON.stringify(storage)}),('public_paths','["/welcome"]'),('settings_revision','2')`;
				assert.deepEqual(yield* readSettings, { revision: 2, storage, public_paths: ["/welcome"] });
				assert.deepEqual(yield* readStoragePolicy, storage);
				assert.deepEqual(yield* readPublicPaths, ["/welcome"]);
				const descriptor = yield* parseDescriptor(
					`${engine === "pg" ? "postgres" : "mysql"}://fixture:fixture@localhost/comms_initialize_boot`,
				);
				if (descriptor._tag === "file") return yield* Effect.die("Expected remote descriptor");
				const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
				const journal = yield* remoteDatabaseJournal(descriptor, directory);
				assert.deepEqual(yield* journal.list, []);
				yield* sql`INSERT INTO settings VALUES('remoteXdatabase:ignored','not JSON')`;
				assert.deepEqual(yield* journal.list, []);
				const id = "12345678-1234-4123-8123-123456789012";
				const record = {
					id,
					kind: "dump",
					endpoint: engine === "pg" ? "postgres://localhost:5432" : "mysql://localhost:3306",
					database: "source",
					principal: "comms_t_123456781234412381231234",
					phase: "allocated",
				};
				yield* sql`INSERT INTO settings VALUES(${`remote_database:${id}`},${JSON.stringify(record)})`;
				assert.deepEqual(yield* journal.list, [record]);
				yield* sql`UPDATE settings SET value='invalid JSON' WHERE ${sql("key")}=${`remote_database:${id}`}`;
				const invalid = yield* journal.list.pipe(Effect.result);
				assert.equal(invalid._tag, "Failure");
				if (invalid._tag === "Failure") assert.equal(Schema.is(RemoteDatabaseError)(invalid.failure), true);
			}),
		);
	}).pipe(Effect.provide(layer));
	return { engine, passed: true };
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(
	Effect.flatMap((value) => Console.log(JSON.stringify(value))),
	BunRuntime.runMain,
);
