import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, FileSystem, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import type { TransferSelection } from "@comms/storage/store-transfer-schema";
import type { RemoteStore } from "@comms/storage/store";
import { configuration } from "./remote-keeper-config.ts";
import { launchRemoteRoot } from "../../src/remote-root-launcher.ts";
import { remoteRuntime } from "../../src/remote-runtime.ts";
import { mysqlDatabaseProvision } from "../../src/mysql-database-provision.ts";
import { postgresDatabaseProvision } from "../../src/postgres-database-provision.ts";
import { RemoteDatabaseError } from "../../src/remote-database-journal.ts";
import { transferDumpJournal } from "../../src/transfer-dump-journal.ts";
import { nativeTransferSafetyCopy } from "../../src/transfer-native-safety-copy.ts";

const Snapshot = Schema.fromJsonString(
	Schema.Struct({
		boot: Schema.Struct({
			settings: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
			evidence: Schema.Array(Schema.Struct({ id: Schema.Int, body: Schema.String })),
		}),
		app: Schema.Struct({
			settings: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
			evidence: Schema.Array(Schema.Struct({ id: Schema.Int, body: Schema.String })),
		}),
	}),
);
const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(process.env.TRANSFER_SAFETY_ROOT ?? process.argv[2] ?? "");
	const phase = process.env.TRANSFER_SAFETY_PHASE ?? process.argv[3];
	assert.ok(phase === "provision" || phase === "recover-capture");
	const config = yield* configuration;
	if (!process.env.COMMS_REMOTE_ROOT_CONFIG) {
		const code = yield* Effect.scoped(
			launchRemoteRoot(config, {
				dataDirectory: root,
				entry: fileURLToPath(import.meta.url),
				env: { TRANSFER_SAFETY_ROOT: root, TRANSFER_SAFETY_PHASE: phase },
			}),
		);
		assert.equal(Number(code), 0, "Guarded transfer safety worker failed");
		yield* Console.log(`NATIVE_TRANSFER_SAFETY_${phase}_VERIFIED`);
		return;
	}
	yield* Console.error("stage:runtime");
	const runtime = yield* remoteRuntime(config, root);
	const selection: TransferSelection = {
		version: 1,
		transfer_id: "11111111-1111-4111-8111-111111111111",
		data_directory: root,
		store_id: "22222222-2222-4222-8222-222222222222",
		source: {
			engine: config.boot._tag === "postgres" ? "pg" : "mysql",
			endpoint: `${config.bootConnection.host}:${config.bootConnection.port}`,
			boot: config.boot.database,
			app: config.app.database,
		},
		target: { engine: "sqlite", endpoint: null, boot: `${root}/target-boot.db`, app: `${root}/target-app.db` },
	};
	const source = { boot: config.boot, app: config.app };
	yield* Console.error("stage:journal");
	const journal = yield* transferDumpJournal(selection, source);
	const withSource = <A, E>(store: RemoteStore, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
		store.database === config.boot.database
			? effect.pipe(Effect.provideService(SqlClient.SqlClient, runtime.bootSql))
			: runtime.withStore(store, effect);
	const rows = (store: RemoteStore) =>
		withSource(
			store,
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return {
					settings: yield* sql`SELECT ${sql("key")},value FROM settings ORDER BY ${sql("key")}`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
						),
					),
					evidence: yield* sql`SELECT id,body FROM transfer_safety_evidence ORDER BY id`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.Int, body: Schema.String }))),
						),
					),
				};
			}),
		);
	const snapshot = Effect.gen(function* () {
		return { boot: yield* rows(config.boot), app: yield* rows(config.app) };
	});
	const principalExists = (principal: string) =>
		(config.boot._tag === "postgres"
			? runtime.bootSql`SELECT rolname FROM pg_roles WHERE rolname=${principal}`
			: runtime.bootSql`SELECT USER FROM information_schema.USER_ATTRIBUTES WHERE USER=${principal}`
		).pipe(Effect.map((rows) => rows.length !== 0));
	if (phase === "provision") {
		yield* Console.error("stage:seed-pair");
		for (const store of [config.boot, config.app])
			yield* withSource(
				store,
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					// These explicitly supplied pairs are fresh. Never adopt or erase an existing fixture/board.
					const tables =
						store._tag === "postgres"
							? yield* sql`SELECT tablename FROM pg_tables WHERE schemaname='public'`
							: yield* sql`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=${store.database}`;
					assert.equal(tables.length, 0, "Native safety fixture requires empty dedicated source stores");
					yield* sql`CREATE TABLE settings(${sql("key")} VARCHAR(255) PRIMARY KEY,value TEXT NOT NULL)`;
					yield* sql`CREATE TABLE transfer_safety_evidence(id INTEGER PRIMARY KEY,body TEXT NOT NULL)`;
					yield* sql`INSERT INTO settings(${sql("key")},value) VALUES('fixture',${store.database})`;
					yield* sql`INSERT INTO transfer_safety_evidence VALUES(1,${`${store.database}: 🐘 café source row`})`;
				}),
			);
		yield* fs.writeFileString(`${root}/source-before.json`, yield* Schema.encodeEffect(Snapshot)(yield* snapshot), {
			flag: "wx",
			mode: 0o600,
		});
		const mysql = mysqlDatabaseProvision({
			created: () => Effect.die("Unexpected database creation"),
			owns: () => Effect.die("Unexpected database ownership"),
		});
		const selected: Effect.Effect<
			Effect.Success<typeof postgresDatabaseProvision> | Effect.Success<typeof mysql>,
			Effect.Error<typeof postgresDatabaseProvision> | Effect.Error<typeof mysql>,
			SqlClient.SqlClient
		> = config.boot._tag === "postgres" ? postgresDatabaseProvision : mysql;
		const provision = yield* selected.pipe(Effect.provideService(SqlClient.SqlClient, runtime.bootSql));
		yield* Console.error("stage:allocate-dump");
		const record = yield* journal.allocate("boot");
		yield* provision.createPrincipal(record, yield* journal.credential(record.id));
		yield* withSource(config.boot, selected.pipe(Effect.flatMap((service) => service.grantDump(record))));
		if (config.boot._tag === "postgres") {
			const privileges = yield* runtime.bootSql`SELECT
                has_table_privilege(${record.principal}, 'public.transfer_safety_evidence', 'SELECT') AS readable,
                has_table_privilege(${record.principal}, 'public.transfer_safety_evidence', 'INSERT') AS insertable,
                has_table_privilege(${record.principal}, 'public.transfer_safety_evidence', 'UPDATE') AS updatable,
                has_table_privilege(${record.principal}, 'public.transfer_safety_evidence', 'DELETE') AS deletable,
                has_schema_privilege(${record.principal}, 'public', 'CREATE') AS creatable`;
			assert.deepEqual(privileges, [
				{ readable: true, insertable: false, updatable: false, deletable: false, creatable: false },
			]);
		}
		yield* journal.ready(record.id);
		const dumpReference = { transferId: selection.transfer_id, resourceId: record.id };
		const dumpCredential = yield* journal.credential(record.id);
		for (const reservation of [
			runtime.reserveOwner(dumpCredential, "a".repeat(64), "account"),
			runtime.reserveOwner(config.boot, "b".repeat(64), "account", dumpReference),
			runtime.reserveOwner(config.app, "c".repeat(64), "account", dumpReference),
			runtime.reserveOwner(dumpCredential, "d".repeat(64), "database", dumpReference),
		])
			assert.equal((yield* reservation.pipe(Effect.result))._tag, "Failure");
		assert.equal((yield* journal.read(record.id)).phase, "ready");
		assert.equal(yield* principalExists(record.principal), true);
		// Exit with a ready principal/grant, before native keeper admission.
		return;
	}
	const before = yield* fs
		.readFileString(`${root}/source-before.json`)
		.pipe(Effect.flatMap(Schema.decodeEffect(Snapshot)));
	assert.deepEqual(yield* snapshot, before);
	const pending = yield* journal.list;
	assert.equal(pending.length, 1);
	const interrupted = pending[0];
	assert.ok(interrupted);
	assert.ok(interrupted.phase === "allocated" || interrupted.phase === "ready");
	assert.equal(yield* principalExists(interrupted.principal), true);
	const safety = yield* nativeTransferSafetyCopy({ selection, source, runtime, budgetMs: 30000 });
	yield* Console.error("stage:recover-provisioned-dump");
	yield* safety.recover;
	assert.deepEqual(yield* journal.list, []);
	assert.equal(yield* principalExists(interrupted.principal), false);
	assert.equal(yield* journal.isFinished(interrupted.id), true);
	yield* Console.error("stage:capture-native-pair");
	const captured = yield* safety.capture;
	yield* Console.error("stage:verify-native-pair");
	assert.deepEqual(yield* safety.verify(captured.path), captured.receipt);
	assert.deepEqual(
		captured.receipt.files.map((file) => file.store),
		["boot", "app"],
	);
	for (const file of captured.receipt.files) {
		assert.ok(file.bytes > 0);
		assert.equal((yield* fs.stat(yield* journal.pathFor(file.resource_id))).size, BigInt(file.bytes));
		assert.equal(yield* journal.isFinished(file.resource_id), true);
		assert.equal(yield* principalExists((yield* journal.read(file.resource_id)).principal), false);
	}
	assert.deepEqual(yield* journal.list, []);
	const after = yield* snapshot;
	assert.deepEqual(after, before, "Native safety copy must not write source rows or recovery intents");
	for (const store of [after.boot, after.app])
		assert.equal(
			store.settings.some((row) => row.key.startsWith("remote_database:")),
			false,
		);
});
program.pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
	Effect.catchCause((cause) =>
		Effect.gen(function* () {
			const found = Cause.findError(cause);
			if (found._tag === "Success" && Schema.is(RemoteDatabaseError)(found.success))
				yield* Console.error(`provision:${found.success.code}:${found.success.stage ?? "unknown"}`);
			if (
				found._tag === "Success" &&
				typeof found.success === "object" &&
				found.success !== null &&
				"code" in found.success &&
				typeof found.success.code === "string" &&
				/^(remote_|store_|transfer_)[a-z_]+$/.test(found.success.code)
			)
				yield* Console.error(`failure:${found.success.code}`);
			return yield* Effect.die("Native transfer safety fixture failed; credentials omitted");
		}),
	),
	BunRuntime.runMain,
);
