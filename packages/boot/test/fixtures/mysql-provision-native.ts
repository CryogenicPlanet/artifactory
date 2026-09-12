import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import { mysqlDatabaseProvision } from "../../src/mysql-database-provision.ts";
import { RemoteDatabaseError, remoteDatabaseJournal } from "../../src/remote-database-journal.ts";
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
class FixtureError extends Schema.TaggedError<FixtureError>()("FixtureError", { code: Schema.String }) {}
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = process.argv[2],
		directory = process.argv[3];
	if (!root || !directory) return yield* Effect.fail(new FixtureError({ code: "Missing fixture paths" }));
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
	yield* Console.error("stage:configuration");
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
					poolConfig: {
						bigNumberStrings: true,
						jsonStrings: true,
						connectAttributes: { comms_attempt: "native-provision-test" },
					},
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
			yield* Console.error("stage:principal");
			yield* provision.createPrincipal(record, credential);
			yield* Console.error("stage:database");
			yield* provision.createDatabase(record);
			const outerBootSql = yield* SqlClient.SqlClient;
			const bootConnections =
				yield* outerBootSql`SELECT CAST(CONNECTION_ID() AS CHAR) AS id FROM performance_schema.session_account_connect_attrs WHERE PROCESSLIST_ID=CONNECTION_ID() AND ATTR_NAME='comms_attempt'`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))),
				);
			const bootConnectionId = bootConnections[0]?.id;
			if (!bootConnectionId) return yield* Effect.fail(new FixtureError({ code: "Missing boot connection" }));
			yield* using(
				credential,
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* Console.error("stage:session_identity");
					const attributes =
						yield* sql`SELECT ATTR_VALUE AS value FROM performance_schema.session_account_connect_attrs WHERE PROCESSLIST_ID=CONNECTION_ID() AND ATTR_NAME='comms_attempt'`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
						);
					if (attributes.length !== 1 || attributes[0]?.value !== "native-provision-test")
						return yield* Effect.fail(new FixtureError({ code: "Missing native session owner attribute" }));

					// An independently authenticated account's attributes are never visible through this account-scoped table.
					const foreign =
						yield* sql`SELECT ATTR_VALUE FROM performance_schema.session_account_connect_attrs WHERE PROCESSLIST_ID=${bootConnectionId}`;
					if (foreign.length !== 0)
						return yield* Effect.fail(new FixtureError({ code: "Unrelated account attributes exposed" }));
					yield* sql`CREATE TABLE permitted(id integer PRIMARY KEY)`;
					yield* sql`INSERT INTO permitted VALUES(1)`;
					const denied = yield* sql
						.unsafe(`SELECT * FROM \`${boot.database.replaceAll("`", "``")}\`.settings`)
						.pipe(Effect.result);
					if (denied._tag !== "Failure") return yield* Effect.fail(new FixtureError({ code: "Clone could read boot" }));
				}),
			);
			yield* Console.error("stage:dump");
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
					if (denied._tag !== "Failure")
						return yield* Effect.fail(new FixtureError({ code: "Dump could write source" }));
				}),
			);
			const lowVisibility = yield* using(
				dumpCredential,
				Effect.gen(function* () {
					const local = yield* mysqlDatabaseProvision(resources);
					return yield* local.assertSupported(dump).pipe(Effect.result);
				}),
			);
			if (lowVisibility._tag !== "Failure")
				return yield* Effect.fail(new FixtureError({ code: "Hidden catalogs accepted" }));
			yield* Console.error("stage:advanced_objects");
			const advanced = yield* read("mysql-dbops-advanced");
			const advancedRecord = yield* resources.allocate("dump", advanced);
			const refused = yield* using(
				advanced,
				Effect.gen(function* () {
					const local = yield* mysqlDatabaseProvision(resources);
					return yield* local.assertSupported(advancedRecord).pipe(Effect.result);
				}),
			);
			if (
				refused._tag !== "Failure" ||
				!(refused.failure instanceof RemoteDatabaseError) ||
				refused.failure.code !== "mysql_clone_objects_unsupported"
			)
				return yield* Effect.fail(new FixtureError({ code: "Advanced objects not refused" }));
			yield* resources.phase(advancedRecord.id, "allocated", "closed");
			yield* resources.forget(advancedRecord.id);

			yield* Console.error("stage:cleanup");
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
			if (remaining.length !== 0)
				return yield* Effect.fail(new FixtureError({ code: "Scratch retained after proven cleanup" }));
			return { created: true, scoped: true, readOnlyDump: true, hiddenMetadataRefused: true, cleaned: true };
		}),
	);
});
main.pipe(
	Effect.mapError((error) => ({ code: error instanceof FixtureError ? error.code : "native_database_failed" })),
	Effect.result,
	Effect.flatMap((result) => Console.log(JSON.stringify(result))),
	Effect.provide(Reactivity.layer),
	Effect.provide(BunServices.layer),
	Effect.catchCause(() => Console.log(JSON.stringify({ _tag: "Failure", failure: { code: "native_fixture_defect" } }))),
	BunRuntime.runMain,
);
