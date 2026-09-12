import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Redacted, Schema } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { SqlClient } from "effect/unstable/sql";
import * as PgClient from "@effect/sql-pg/PgClient";
import { dumpRemote, loadRemote } from "@comms/storage/remote-copy";
import { withDatabase, type RemoteStore } from "@comms/storage/store";
import { postgresDatabaseProvision } from "../../src/postgres-database-provision.ts";
import { remoteDatabaseJournal } from "../../src/remote-database-journal.ts";
const Configuration = Schema.fromJsonString(
	Schema.Struct({
		host: Schema.String,
		port: Schema.Number,
		database: Schema.String,
		username: Schema.String,
		password: Schema.String,
	}),
);
const withStore = <A, E, R>(store: RemoteStore, effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const url = new URL(Redacted.value(store.url));
			// This fixture tests DDL/permissions only. Production always supplies keeper-guarded SQL clients.
			const sql = yield* PgClient.make({
				host: url.hostname,
				port: Number(url.port),
				database: store.database,
				username: decodeURIComponent(url.username),
				password: Redacted.make(decodeURIComponent(url.password)),
				ssl: false,
			});
			return yield* effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
		}),
	);
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = process.argv[2],
		data = process.argv[3];
	if (!root || !data) return yield* Effect.die("Missing fixture paths");
	const read = (name: string) =>
		fs.readFileString(`${root}/${name}.json`).pipe(
			Effect.flatMap(Schema.decodeEffect(Configuration)),
			Effect.map((config): RemoteStore => ({
				_tag: "postgres",
				database: config.database,
				url: Redacted.make(
					`postgres://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${encodeURIComponent(config.database)}`,
				),
			})),
		);
	const boot = yield* read("pg-dbops-boot"),
		app = yield* read("pg-dbops-app"),
		denied = yield* read("pg-dbops-denied");
	return yield* withStore(
		boot,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)`;
			const journal = yield* remoteDatabaseJournal(boot, data);
			const provision = yield* postgresDatabaseProvision;
			const record = yield* journal.allocate("rehearsal", app);
			const credential = yield* journal.credential(record.id);
			const deniedResult = yield* withStore(
				denied,
				postgresDatabaseProvision.pipe(Effect.flatMap((service) => service.createPrincipal(record, credential))),
			).pipe(Effect.result);
			if (deniedResult._tag !== "Failure") return yield* Effect.die("Negative role unexpectedly created a principal");
			yield* provision.createPrincipal(record, credential);
			yield* provision.createDatabase(record);
			const selectedBoot = yield* withDatabase(boot, record.database);
			yield* withStore(
				selectedBoot,
				postgresDatabaseProvision.pipe(Effect.flatMap((service) => service.grantSchema(record))),
			);
			yield* withStore(
				credential,
				Effect.gen(function* () {
					const child = yield* SqlClient.SqlClient;
					for (const table of ["kernel_writer", "mutation_batches", "outbox", "store_identity"])
						yield* child`CREATE TABLE ${child(table)}(id INTEGER)`;
					yield* child`CREATE TABLE editable(id INTEGER)`;
				}),
			);
			yield* withStore(
				selectedBoot,
				postgresDatabaseProvision.pipe(Effect.flatMap((service) => service.protectKernel(record))),
			);
			const protection = yield* withStore(
				credential,
				Effect.gen(function* () {
					const child = yield* SqlClient.SqlClient;
					const table = yield* child`DROP TABLE outbox`.pipe(Effect.result);
					const schema = yield* child`DROP SCHEMA public CASCADE`.pipe(Effect.result);
					yield* child`INSERT INTO editable VALUES(1)`;
					yield* child`INSERT INTO outbox VALUES(1)`;
					return table._tag === "Failure" && schema._tag === "Failure";
				}),
			);
			const forbiddenBoot = yield* withDatabase(credential, boot.database);
			const cross = yield* withStore(
				forbiddenBoot,
				Effect.gen(function* () {
					const child = yield* SqlClient.SqlClient;
					yield* child`SELECT value FROM settings`;
				}),
			).pipe(Effect.result);
			let nativeLoad = true;
			if (process.argv[4] === "native") {
				const artifact = yield* dumpRemote({
					store: credential,
					path: `${data}/copy.dump`,
					budget: "10 seconds",
					tls: false,
				});
				const copyRecord = yield* journal.allocate("rehearsal", app);
				const copyCredential = yield* journal.credential(copyRecord.id);
				yield* provision.createPrincipal(copyRecord, copyCredential);
				yield* provision.createDatabase(copyRecord);
				const copyBoot = yield* withDatabase(boot, copyRecord.database);
				yield* withStore(
					copyBoot,
					postgresDatabaseProvision.pipe(Effect.flatMap((service) => service.grantSchema(copyRecord))),
				);
				const loaded = yield* loadRemote({
					store: copyCredential,
					artifact,
					budget: "10 seconds",
					tls: false,
					ownership: "current-role",
				}).pipe(Effect.result);
				nativeLoad = loaded._tag === "Success";
				const copyClosed = yield* journal.phase(copyRecord.id, "allocated", "closed");
				yield* provision.dropRehearsal(copyClosed);
				yield* journal.forget(copyRecord.id);
			}
			yield* journal.phase(record.id, "allocated", "ready");
			const closed = yield* journal.phase(record.id, "ready", "closed");
			// All fixture pools above have closed before this explicit cleanup.
			yield* provision.dropRehearsal(closed);
			yield* provision.dropRehearsal(closed);
			yield* journal.forget(record.id);
			return {
				nativeLoad,
				protection,
				crossStoreDenied: cross._tag === "Failure",
				negativePermission: true,
				cleanupRetried: true,
			};
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
