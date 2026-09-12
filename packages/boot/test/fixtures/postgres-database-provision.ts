import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Redacted, Result, Schema } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { SqlClient } from "effect/unstable/sql";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgTypes from "@effect/sql-pg/PgTypes";
import { dumpRemote, loadRemote } from "@comms/storage/remote-copy";
import { asBoot, withDatabase, type RemoteStore } from "@comms/storage/store";
import { remoteDbOps } from "../../src/remote-db-ops.ts";
import { remoteAppStoreIdentity, verifyRemoteAppIdentity } from "../../src/app-store-identity.ts";
import { remoteAppKernelSchema } from "../../src/app-kernel-schema.ts";
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
			const types = PgTypes.makeRegistry();
			types.register(PgTypes.OID.int8, {
				encode: (value) => PgTypes.encode(value, PgTypes.OID.int8),
				decode: (bytes) =>
					Result.flatMap(PgTypes.decode(bytes, PgTypes.OID.int8, 1), (value) => {
						const number = typeof value === "bigint" ? Number(value) : NaN;
						return Number.isSafeInteger(number)
							? Result.succeed(number)
							: Result.fail(new PgTypes.CodecError({ message: "unsafe fixture integer" }));
					}),
			});
			const sql = yield* PgClient.make({
				types,
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
			if (process.argv[4] === "factory") {
				yield* sql`CREATE TABLE IF NOT EXISTS seq(singleton INTEGER PRIMARY KEY)`;
				yield* sql`INSERT INTO seq VALUES(1) ON CONFLICT DO NOTHING`;
				const identity = yield* remoteAppStoreIdentity(app);
				yield* Console.error("stage:reserve");
				const adoption = yield* identity.reserve;
				const bootApp = yield* asBoot(app, boot);
				const appRole = decodeURIComponent(new URL(Redacted.value(app.url)).username);
				yield* withStore(
					bootApp,
					Effect.gen(function* () {
						const target = yield* SqlClient.SqlClient;
						let operation = 0;
						for (const op of remoteAppKernelSchema(target, appRole)) {
							yield* Console.error(`stage:kernel_${operation++}`);
							yield* op;
						}
						yield* Console.error("stage:verify");
						yield* target.withTransaction(verifyRemoteAppIdentity(adoption));
						yield* target`INSERT INTO kernel_writer VALUES(1,'live') ON CONFLICT DO NOTHING`;
					}),
				);
				yield* Console.error("stage:complete");
				yield* identity.complete(adoption);
				yield* withStore(
					app,
					Effect.gen(function* () {
						const child = yield* SqlClient.SqlClient;
						yield* child`CREATE TABLE IF NOT EXISTS dbops_messages(body TEXT)`;
						yield* child`DELETE FROM dbops_messages`;
						yield* child`INSERT INTO dbops_messages VALUES('retained')`;
					}),
				);
				yield* Console.error("stage:factory_construct");
				const service = yield* remoteDbOps({
					store: Effect.succeed(app),
					bootStore: boot,
					dataDirectory: data,
					withStore: (store, effect) =>
						asBoot(store, boot).pipe(
							Effect.flatMap((selected) => withStore(selected, effect)),
							Effect.provide(Reactivity.layer),
						),
					withNative: (request) =>
						(request.operation === "dump"
							? dumpRemote({ store: request.store, path: request.path, budget: request.budgetMs, tls: false })
							: loadRemote({
									store: request.store,
									artifact: request.artifact,
									budget: request.budgetMs,
									tls: false,
									ownership: request.ownership,
								}).pipe(Effect.as({ ...request.artifact, bytes: 0 }))
						).pipe(Effect.provide(BunServices.layer)),
					assertAccountClosed: (_id, store) =>
						Effect.gen(function* () {
							const username = decodeURIComponent(new URL(Redacted.value(store.url)).username);
							const rows = yield* sql`SELECT pid FROM pg_stat_activity WHERE usename=${username}`;
							if (rows.length !== 0) return yield* Effect.die("Fixture account still open");
						}),
				});
				yield* Console.error("stage:backup");
				const bytes = yield* service.clone({ _tag: "file", filename: `${data}/backup.dump` });
				yield* Console.error("stage:rehearsal");
				const rehearsal = yield* service.rehearsal({ _tag: "file", filename: `${data}/rehearsal.dump` }, "candidate");
				const rehearsed = yield* withStore(
					rehearsal.store,
					Effect.gen(function* () {
						const child = yield* SqlClient.SqlClient;
						return yield* child`SELECT body FROM dbops_messages`;
					}),
				);
				yield* rehearsal.dispose;
				yield* withStore(
					app,
					Effect.gen(function* () {
						const child = yield* SqlClient.SqlClient;
						yield* child`INSERT INTO dbops_messages VALUES('later')`;
					}),
				);
				yield* Console.error("stage:restore");
				const restored = yield* service.restoreInto({
					path: `${data}/backup.dump`,
					engine: "pg",
					legacy_store_id: null,
				});
				yield* Console.error("stage:restored_read");
				const restoredRows = yield* withStore(
					restored,
					Effect.gen(function* () {
						const child = yield* SqlClient.SqlClient;
						yield* child`INSERT INTO dbops_messages VALUES('restored write')`;
						return yield* child`SELECT body FROM dbops_messages`;
					}),
				);
				const originalRows = yield* withStore(
					app,
					Effect.gen(function* () {
						const child = yield* SqlClient.SqlClient;
						return yield* child`SELECT body FROM dbops_messages`;
					}),
				);
				const journal = yield* remoteDatabaseJournal(boot, data);
				const retained = (yield* journal.list).filter(
					(record) => record.kind === "restore" && record.database === restored.database,
				);
				const unselected = (yield* identity.store).database === app.database;
				// Explicit fixture cleanup, after proving production retained the fresh restore target.
				yield* sql`DROP DATABASE ${sql(restored.database)}`;
				for (const record of retained) yield* sql`DELETE FROM settings WHERE key=${`remote_database:${record.id}`}`;
				return {
					factory: true,
					bytes: bytes > 0n,
					rehearsed: rehearsed.length,
					restored: restoredRows.length,
					original: originalRows.length,
					retained: retained.length,
					unselected,
				};
			}
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
