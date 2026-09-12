import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Console, Crypto, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { FetchHttpClient } from "effect/unstable/http";
import { fileURLToPath } from "node:url";
import { configuration } from "./remote-keeper-config.ts";
import { launchRemoteRoot } from "../../src/remote-root-launcher.ts";
import { remoteRuntime } from "../../src/remote-runtime.ts";
import { NativeCopyRejected } from "../../src/native-copy-configuration.ts";
import { remoteNativeCopy } from "../../src/remote-native-copy.ts";
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import { Reactivity } from "effect/unstable/reactivity";
import { connectionOf, type RemoteStore } from "@comms/storage/store";
import { remoteAppStoreIdentity, verifyRemoteAppIdentity } from "../../src/app-store-identity.ts";
import { remoteAppKernelSchema } from "../../src/app-kernel-schema.ts";
import { RemoteDatabaseError, remoteDatabaseJournal } from "../../src/remote-database-journal.ts";
import { remoteDbOps } from "../../src/remote-db-ops.ts";
// Permission smoke only: this short app pool closes before the guardian is retired.
const asApp = <A, E>(store: RemoteStore, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
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
			});
			return yield* effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
		}),
	).pipe(Effect.provide(Reactivity.layer));
const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(process.env.GUARDIAN_TEST_ROOT ?? process.argv[2] ?? "");
	const config = yield* configuration;
	if (!process.env.COMMS_REMOTE_ROOT_CONFIG) {
		const code = yield* Effect.scoped(
			launchRemoteRoot(config, {
				dataDirectory: root,
				entry: fileURLToPath(import.meta.url),
				env: { GUARDIAN_TEST_ROOT: root },
			}),
		);
		if (Number(code) !== 0) return yield* Effect.die("Guarded native DbOps fixture failed");
		yield* Console.log("GUARDED_DBOPS_COPY_VERIFIED");
		return;
	}
	yield* Console.error("stage:runtime");
	const runtime = yield* remoteRuntime(config, root);
	const native = yield* remoteNativeCopy(runtime);
	yield* runtime.bootSql`CREATE TABLE IF NOT EXISTS settings(\`key\` VARCHAR(255) PRIMARY KEY,value LONGTEXT NOT NULL)`;
	yield* runtime.bootSql`CREATE TABLE IF NOT EXISTS seq(singleton INTEGER PRIMARY KEY)`;
	yield* runtime.bootSql`INSERT IGNORE INTO seq VALUES(1)`;
	const identity = yield* remoteAppStoreIdentity(config.app).pipe(
		Effect.provideService(SqlClient.SqlClient, runtime.bootSql),
	);
	const adoption = yield* identity.reserve;
	const marker = yield* (yield* Crypto.Crypto).randomUUIDv4;
	yield* runtime.withStore(
		config.app,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const role = decodeURIComponent(new URL(Redacted.value(config.app.url)).username);
			for (const operation of remoteAppKernelSchema(sql, role)) yield* operation;
			yield* sql.withTransaction(verifyRemoteAppIdentity(adoption));
			yield* sql`CREATE TABLE IF NOT EXISTS dbops_restore_messages(id VARCHAR(36) PRIMARY KEY,body TEXT NOT NULL)`;
			yield* sql`INSERT INTO dbops_restore_messages VALUES(${marker},'before backup')`;
		}),
	);
	yield* identity.complete(adoption);
	const service = yield* remoteDbOps({
		store: Effect.succeed(config.app),
		bootStore: config.boot,
		dataDirectory: root,
		withStore: runtime.withStore,
		withNative: (request) =>
			Console.error("stage:native-start").pipe(
				Effect.andThen(
					native(request).pipe(
						Effect.tapError((error) =>
							Schema.is(NativeCopyRejected)(error)
								? Console.error(`native:${error.code}`)
								: Console.error("native:other"),
						),
					),
				),
				Effect.tap(() => Console.error("stage:native-return")),
			),
		assertAccountClosed: (id, store) =>
			Console.error("stage:account-check").pipe(
				Effect.andThen(runtime.assertAccountClosed(id, store)),
				Effect.tap(() => Console.error("stage:account-closed")),
			),
	}).pipe(Effect.provideService(SqlClient.SqlClient, runtime.bootSql));
	const before = yield* runtime.bootSql`SELECT value FROM settings WHERE \`key\` LIKE 'remote^_database:%' ESCAPE '^'`;
	const accountsBefore =
		yield* runtime.bootSql`SELECT USER,HOST FROM information_schema.USER_ATTRIBUTES WHERE LEFT(USER,8)='comms_t_' ORDER BY USER,HOST`;
	yield* Console.error("stage:clone");
	const bytes = yield* service.clone({ _tag: "file", filename: `${root}/copy.sql` });
	yield* Console.error("stage:clone-return");
	if (bytes <= 0n) return yield* Effect.die("Guarded copy produced no bytes");
	const rows = yield* runtime.bootSql`SELECT value FROM settings WHERE \`key\` LIKE 'remote^_database:%' ESCAPE '^'`;
	const accountsAfter =
		yield* runtime.bootSql`SELECT USER,HOST FROM information_schema.USER_ATTRIBUTES WHERE LEFT(USER,8)='comms_t_' ORDER BY USER,HOST`;
	if (JSON.stringify(accountsAfter) !== JSON.stringify(accountsBefore))
		return yield* Effect.die("Guarded copy left its temporary account");
	if (
		JSON.stringify(rows.map((row) => JSON.stringify(row)).sort()) !==
		JSON.stringify(before.map((row) => JSON.stringify(row)).sort())
	)
		return yield* Effect.die("Guarded copy did not finish resource cleanup");

	// Keep the ordinary mysqldump artifact: historical backups contain LOCK TABLES.
	if (!(yield* fs.readFileString(`${root}/copy.sql`)).includes("LOCK TABLES"))
		return yield* Effect.die("Native fixture did not exercise loader table locks");
	yield* runtime.withStore(
		config.app,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`UPDATE dbops_restore_messages SET body='after backup' WHERE id=${marker}`;
		}),
	);
	yield* Console.error("stage:restore");
	const restored = yield* service.restoreInto({ path: `${root}/copy.sql`, engine: "mysql", legacy_store_id: null });
	if (restored._tag !== "mysql" || restored.database === config.app.database)
		return yield* Effect.die("Restore did not return a fresh MySQL database");
	yield* runtime.withStore(
		restored,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql.withTransaction(verifyRemoteAppIdentity(adoption));
		}),
	);
	yield* asApp(
		restored,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql`SELECT body FROM dbops_restore_messages WHERE id=${marker}`;
			if (rows.length !== 1 || rows[0]?.body !== "before backup") return yield* Effect.die("Restored data mismatch");
			yield* sql`UPDATE dbops_restore_messages SET body='restored write' WHERE id=${marker}`;
			const written = yield* sql`SELECT body FROM dbops_restore_messages WHERE id=${marker}`;
			if (written[0]?.body !== "restored write")
				return yield* Effect.die("Persistent app cannot write restored database");
		}),
	);
	yield* runtime.withStore(
		config.app,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql`SELECT body FROM dbops_restore_messages WHERE id=${marker}`;
			if (rows[0]?.body !== "after backup") return yield* Effect.die("Restore changed source data");
		}),
	);
	const journal = yield* remoteDatabaseJournal(config.boot, root).pipe(
		Effect.provideService(SqlClient.SqlClient, runtime.bootSql),
	);
	const record = (yield* journal.list).filter((record) => record.database === restored.database);
	if (record.length !== 1 || record[0]?.kind !== "restore" || record[0]?.phase !== "closed")
		return yield* Effect.die("Restore lacks retained closed resource receipt");
	const restoredRecord = record[0];
	if (!restoredRecord) return yield* Effect.die("Missing restore receipt");
	if (yield* fs.exists(`${root}/remote-credentials/${restoredRecord.id}.json`))
		return yield* Effect.die("Restore retained its temporary credential");
	const otherRows =
		yield* runtime.bootSql`SELECT value FROM settings WHERE \`key\` LIKE 'remote^_database:%' ESCAPE '^' AND \`key\` <> ${`remote_database:${restoredRecord.id}`}`;
	if (
		JSON.stringify(otherRows.map((row) => JSON.stringify(row)).sort()) !==
		JSON.stringify(before.map((row) => JSON.stringify(row)).sort())
	)
		return yield* Effect.die("Restore changed an unrelated resource journal");
	const accountsRestored =
		yield* runtime.bootSql`SELECT USER,HOST FROM information_schema.USER_ATTRIBUTES WHERE LEFT(USER,8)='comms_t_' ORDER BY USER,HOST`;
	if (JSON.stringify(accountsRestored) !== JSON.stringify(accountsBefore))
		return yield* Effect.die("Restore left its loader account");
	yield* Console.error("stage:restore-verified");
	// Fresh targets and their durable receipts are intentionally retained; the coordinator owns selection.
});
program.pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
	Effect.catchCause((cause) =>
		Effect.gen(function* () {
			const found = Cause.findError(cause);
			if (found._tag === "Success" && Schema.is(RemoteDatabaseError)(found.success))
				yield* Console.error(`provision:${found.success.code}:${found.success.stage ?? "unknown"}`);
			return yield* Effect.die("Guarded native DbOps acceptance failed; credentials omitted");
		}),
	),
	BunRuntime.runMain,
);
