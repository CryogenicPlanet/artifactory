import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import { mysqlDatabaseProvision } from "../../src/mysql-database-provision.ts";
import { remoteDatabaseJournal } from "../../src/remote-database-journal.ts";
import { connectionOf, type RemoteStore } from "@comms/storage/store";

const Config = Schema.fromJsonString(
	Schema.Struct({
		host: Schema.String,
		port: Schema.Number,
		database: Schema.String,
		username: Schema.String,
		password: Schema.String,
	}),
);
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = process.argv[2],
		directory = process.argv[3];
	if (!root || !directory) return yield* Effect.die("Missing fixture paths");
	const read = (name: string) =>
		fs.readFileString(`${root}/${name}.json`).pipe(
			Effect.flatMap(Schema.decodeEffect(Config)),
			Effect.map((config): RemoteStore => ({
				_tag: "mysql",
				database: config.database,
				url: Redacted.make(
					`mysql://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${encodeURIComponent(config.database)}`,
				),
			})),
		);
	const boot = yield* read("mysql-dbops-boot"),
		source = yield* read("mysql-dbops-source");
	// Mechanical provisioning test only: each operation's pool closes before cleanup. No guardian claim.
	const using = <A, E, R>(store: RemoteStore, effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
		Effect.scoped(
			Effect.gen(function* () {
				const connection = yield* connectionOf(store, false);
				const sql = yield* MysqlClient.make({
					host: connection.host,
					port: connection.port,
					database: connection.database,
					username: connection.username,
					password: connection.password,
					maxConnections: 1,
					poolConfig: { bigNumberStrings: true, jsonStrings: true },
				});
				return yield* effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
			}),
		);
	const setup = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`CREATE TABLE IF NOT EXISTS settings(\`key\` varchar(255) PRIMARY KEY,value longtext NOT NULL)`;
	});
	yield* using(boot, setup);
	// Journal captures boot's SQL client; keep its pool alive for this test's entire resource lifecycle.
	return yield* using(
		boot,
		Effect.gen(function* () {
			const resources = yield* remoteDatabaseJournal(boot, directory);
			const provision = yield* mysqlDatabaseProvision(resources);
			const record = yield* resources.allocate("rehearsal", source);
			const credential = yield* resources.credential(record.id);
			yield* provision.createPrincipal(record, credential);
			yield* provision.createDatabase(record);
			yield* using(
				credential,
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE permitted(id integer PRIMARY KEY)`;
					yield* sql`INSERT INTO permitted VALUES(1)`;
					const denied = yield* sql
						.unsafe(`SELECT * FROM \`${boot.database.replaceAll("`", "``")}\`.settings`)
						.pipe(Effect.result);
					if (denied._tag !== "Failure") return yield* Effect.die("Clone could read boot");
				}),
			);
			const dump = yield* resources.allocate("dump", source);
			yield* provision.createPrincipal(dump, yield* resources.credential(dump.id));
			yield* using(
				source,
				Effect.gen(function* () {
					const local = yield* mysqlDatabaseProvision(resources);
					yield* local.grantDump(dump);
				}),
			);
			const dumpCredential = yield* resources.credential(dump.id);
			yield* using(
				dumpCredential,
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const denied = yield* sql`CREATE TABLE forbidden(id integer)`.pipe(Effect.result);
					if (denied._tag !== "Failure") return yield* Effect.die("Dump could write source");
				}),
			);
			const lowVisibility = yield* using(
				dumpCredential,
				Effect.gen(function* () {
					const local = yield* mysqlDatabaseProvision(resources);
					return yield* local.assertSupported(dump).pipe(Effect.result);
				}),
			);
			if (lowVisibility._tag !== "Failure") return yield* Effect.die("Hidden catalogs accepted");
			const closedDump = yield* resources.phase(dump.id, "allocated", "closed");
			yield* using(
				source,
				Effect.gen(function* () {
					const local = yield* mysqlDatabaseProvision(resources);
					yield* local.revokeDump(closedDump);
					yield* local.revokeDump(closedDump);
				}),
			);
			yield* provision.dropPrincipal(closedDump);
			yield* resources.forget(dump.id);
			const closed = yield* resources.phase(record.id, "allocated", "closed");
			yield* provision.dropRehearsal(closed);
			yield* resources.forget(record.id);
			// Opening a lazy driver alone need not connect; inspect the server catalog instead.
			const sql = yield* SqlClient.SqlClient;
			const remaining =
				yield* sql`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=${record.database}`;
			if (remaining.length !== 0) return yield* Effect.die("Scratch retained after proven cleanup");
			return { created: true, scoped: true, readOnlyDump: true, hiddenMetadataRefused: true, cleaned: true };
		}),
	);
});
main.pipe(
	Effect.result,
	Effect.flatMap((result) => Console.log(JSON.stringify(result))),
	Effect.provide(Reactivity.layer),
	Effect.provide(BunServices.layer),
	BunRuntime.runMain,
);
