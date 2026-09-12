import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Context, Crypto, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { clientLayer } from "@comms/storage/client";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { type RemoteConnection } from "@comms/storage/remote-session";
import { parseDescriptor, type Store } from "@comms/storage/store";
import { selectionText, type TransferSelection } from "@comms/storage/store-transfer-schema";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { makeTransferKernelInitializer } from "../../src/transfer-kernel-initialize.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const main = Effect.gen(function* () {
	const [directory, engine, mode] = process.argv.slice(2);
	if (!directory || !mode || !["sqlite", "pg", "mysql"].includes(engine ?? ""))
		return yield* Effect.die("Missing transfer fixture arguments");
	const fs = yield* FileSystem.FileSystem;
	const openFile = (filename: string) =>
		Layer.build(clientLayer({ _tag: "file", filename })).pipe(
			Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
		);
	const openRemote = (settings: typeof Settings.Type) =>
		Effect.gen(function* () {
			const connection: RemoteConnection = { ...settings, password: Redacted.make(settings.password), tls: false };
			const attempt = Buffer.from(yield* (yield* Crypto.Crypto).randomBytes(32)).toString("hex");
			const context = yield* Layer.build(
				remoteClientLayer({ connection, attempt, register: () => Effect.void }).pipe(
					Layer.provide(remoteInspectorLayer({ connection, attempt })),
				),
			);
			return Context.get(context, SqlClient.SqlClient);
		});
	const selected = yield* Effect.gen(function* () {
		if (engine === "sqlite") {
			const appStore: Store = { _tag: "file", filename: `${directory}/app.db` };
			const bootStore: Store = { _tag: "file", filename: `${directory}/boot.db` };
			return {
				appStore,
				bootStore,
				app: yield* openFile(appStore.filename),
				boot: yield* openFile(bootStore.filename),
				endpoint: null,
			};
		}
		const read = (suffix: string) =>
			fs
				.readFileString(`${directory}/${engine}-initialize-${suffix}.json`)
				.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Settings))));
		const appConfig = yield* read("app"),
			bootConfig = yield* read("boot"),
			writer = yield* read("boot-app");
		if (
			appConfig.database !== "comms_initialize_app" ||
			bootConfig.database !== "comms_initialize_boot" ||
			writer.database !== appConfig.database ||
			writer.username !== bootConfig.username
		)
			return yield* Effect.die("Nonfixture database refused");
		const descriptor = (c: typeof Settings.Type) =>
			parseDescriptor(
				`${engine === "pg" ? "postgres" : "mysql"}://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`,
			);
		return {
			appStore: yield* descriptor(appConfig),
			bootStore: yield* descriptor(bootConfig),
			app: yield* openRemote(writer),
			boot: yield* openRemote(bootConfig),
			endpoint: `${appConfig.host}:${appConfig.port}`,
		};
	});
	const { app, boot, appStore, bootStore } = selected;
	yield* initializeBootSchema.pipe(Effect.provideService(SqlClient.SqlClient, boot));
	const store_id = "11111111-1111-4111-8111-111111111111";
	const selection: TransferSelection = {
		version: 1,
		transfer_id: "22222222-2222-4222-8222-222222222222",
		store_id,
		data_directory: directory,
		source: {
			engine: "sqlite",
			endpoint: null,
			boot: `${directory}/source-boot.db`,
			app: `${directory}/source-app.db`,
		},
		target: {
			engine: engine === "pg" ? "pg" : engine === "mysql" ? "mysql" : "sqlite",
			endpoint: selected.endpoint,
			boot: bootStore._tag === "file" ? bootStore.filename : bootStore.database,
			app: appStore._tag === "file" ? appStore.filename : appStore.database,
		},
	};
	if (mode === "reset") {
		for (const name of [
			"kernel_migration_intent",
			"outbox",
			"mutation_batches",
			"kernel_writer",
			"store_identity",
			"intruder",
		])
			yield* app`DROP TABLE IF EXISTS ${app(name)}`;
		yield* boot`DROP TABLE IF EXISTS store_identity`;
		yield* boot`DROP TABLE IF EXISTS kernel_writer`;
		yield* boot`DELETE FROM settings`;
		return { reset: true };
	}
	if (
		(yield* boot`SELECT value FROM settings WHERE ${boot("key")}='transfer_state'`).length === 0 &&
		mode !== "missing-reservation"
	)
		yield* boot`INSERT INTO settings(${boot("key")},value) VALUES('transfer_state','in_progress'),('transfer_prepare',${selectionText(selection)})`;
	if (mode === "foreign") yield* app`CREATE TABLE intruder(value TEXT)`;
	const initialize = yield* makeTransferKernelInitializer({ appStore, bootStore }).pipe(
		Effect.provideService(SqlClient.SqlClient, boot),
	);
	const seed = { initialized_at: 123456, epoch: "a".repeat(64) };
	const selectedSeed =
		mode === "wrong-epoch"
			? { ...seed, epoch: "b".repeat(64) }
			: mode === "newline-epoch"
				? { ...seed, epoch: seed.epoch + "\n" }
				: mode === "invalid-epoch"
					? { ...seed, epoch: "not-a-writer-epoch" }
					: seed;
	const selectedBinding =
		mode === "wrong-selection" ? { ...selection, transfer_id: "33333333-3333-4333-8333-333333333333" } : selection;
	if (mode === "wrong-opened-app") {
		yield* boot`CREATE TABLE store_identity(singleton INTEGER PRIMARY KEY,store_id VARCHAR(36),initialized_at BIGINT,transferred_to TEXT)`;
		yield* boot`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch VARCHAR(128))`;
		yield* boot`INSERT INTO store_identity VALUES(1,${store_id},${seed.initialized_at},NULL)`;
		yield* boot`INSERT INTO kernel_writer VALUES(1,${seed.epoch})`;
	}
	const result = yield* initialize(selectedBinding, selectedSeed).pipe(
		Effect.provideService(SqlClient.SqlClient, mode === "wrong-opened-app" ? boot : app),
		Effect.result,
	);
	const rows = yield* boot`SELECT value FROM settings WHERE ${boot("key")}='transfer_kernel'`;
	const tables = yield* (
		engine === "sqlite"
			? app`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
			: engine === "pg"
				? app`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`
				: app`SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE()`
	).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))));
	const names = tables.map((row) => row.name).sort();
	const identities = names.includes("store_identity")
		? yield* app`SELECT store_id,initialized_at FROM store_identity`
		: [];
	return { ok: result._tag === "Success", tables: names, progress: rows[0]?.value, identities };
});
main.pipe(
	Effect.scoped,
	Effect.flatMap((value) => Console.log(JSON.stringify(value))),
	Effect.provide(BunServices.layer),
	BunRuntime.runMain,
);
