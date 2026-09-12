import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Context, Crypto, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { type RemoteConnection } from "@comms/storage/remote-session";
import { parseDescriptor } from "@comms/storage/store";
import { makeRemoteAppInitializer } from "../../src/app-kernel-initialize.ts";
import { remoteAppStoreIdentity } from "../../src/app-store-identity.ts";
import { EventError } from "../../src/events.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const open = (connection: RemoteConnection, bootConnection: RemoteConnection) =>
	Effect.gen(function* () {
		const attempt = (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "").repeat(2);
		const options = { connection, attempt };
		const context = yield* Layer.build(
			remoteClientLayer({ ...options, register: () => Effect.void }).pipe(
				Layer.provide(
					remoteInspectorLayer({
						...options,
						...(connection.engine === "mysql" ? { mysqlBootConnection: bootConnection } : {}),
					}),
				),
			),
		);
		return Context.get(context, SqlClient.SqlClient);
	});
const main = Effect.gen(function* () {
	const [directory, engine, mode] = process.argv.slice(2);
	if (!directory || !mode || (engine !== "pg" && engine !== "mysql"))
		return yield* Effect.die("Expected disposable initializer configuration and mode");
	const fs = yield* FileSystem.FileSystem;
	const read = (suffix: string) =>
		fs
			.readFileString(`${directory}/${engine}-initialize-${suffix}.json`)
			.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Settings))));
	const bootConfig = yield* read("boot");
	const bootAppConfig = yield* read("boot-app");
	const appConfig = yield* read("app");
	if (
		bootConfig.database !== "comms_initialize_boot" ||
		bootAppConfig.database !== "comms_initialize_app" ||
		appConfig.database !== "comms_initialize_app" ||
		bootConfig.username !== bootAppConfig.username ||
		appConfig.username === bootConfig.username
	)
		return yield* Effect.die("Refusing non-disposable initializer stores");
	const connection = (settings: typeof Settings.Type): RemoteConnection => ({
		...settings,
		password: Redacted.make(settings.password),
		tls: false,
	});
	const descriptor = (config: typeof Settings.Type) =>
		parseDescriptor(
			`${engine === "pg" ? "postgres" : "mysql"}://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}`,
		).pipe(Effect.flatMap((store) => (store._tag === "file" ? Effect.die("Expected remote") : Effect.succeed(store))));
	const bootStore = yield* descriptor(bootConfig);
	const appStore = yield* descriptor(appConfig);
	const boot = yield* open(connection(bootConfig), connection(bootConfig));
	const app = yield* open(connection(bootAppConfig), connection(bootConfig));
	const operator = yield* open(connection(appConfig), connection(bootConfig));
	const suffix = engine === "mysql" ? " ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin" : "";
	yield* boot.unsafe(
		`CREATE TABLE IF NOT EXISTS settings (${engine === "mysql" ? "`key`" : "key"} VARCHAR(256) PRIMARY KEY,value TEXT NOT NULL)${suffix}`,
	);
	yield* boot.unsafe(`CREATE TABLE IF NOT EXISTS seq (singleton INTEGER PRIMARY KEY)${suffix}`);
	const seq = yield* boot`SELECT singleton FROM seq`;
	if (seq.length === 0) yield* boot`INSERT INTO seq VALUES(1)`;
	if (mode === "reset") {
		for (const table of [
			"kernel_migration_intent",
			"intruder",
			"owned_extension",
			"outbox",
			"mutation_batches",
			"kernel_writer",
			"store_identity",
		])
			yield* app`DROP TABLE IF EXISTS ${app(table)}`;
		yield* boot`DELETE FROM settings`;
		return { reset: true };
	}
	const identity = yield* remoteAppStoreIdentity(appStore).pipe(Effect.provideService(SqlClient.SqlClient, boot));
	const adoption = yield* identity.reserve;
	const initialize = yield* makeRemoteAppInitializer({ appStore, bootStore }).pipe(
		Effect.provideService(SqlClient.SqlClient, boot),
	);
	const run = (selected = adoption) => initialize(selected).pipe(Effect.provideService(SqlClient.SqlClient, app));
	const snapshot = Effect.gen(function* () {
		const progress = yield* boot`SELECT value FROM settings WHERE ${boot("key")}='app_store_schema'`;
		const tables = yield* app.onDialectOrElse({
			pg: () =>
				app`SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`,
			orElse: () =>
				app`SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`,
		});
		return { progress: progress[0]?.value, tables: tables.map((row) => row.name), storeId: adoption.store_id };
	});
	if (mode === "snapshot") return yield* snapshot;
	if (mode === "foreign") yield* operator`CREATE TABLE intruder(value INTEGER)`;
	if (mode === "ready") yield* identity.complete(adoption);
	if (mode === "foreign-active") {
		if (engine !== "pg") return yield* Effect.die("Ownership test is PostgreSQL-only");
		yield* run();
		for (const table of ["outbox", "mutation_batches", "kernel_writer", "store_identity"])
			yield* app`DROP TABLE ${app(table)}`;
		yield* operator`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL)`;
		yield* operator`INSERT INTO kernel_writer VALUES(1,'preserved')`;
		const rows = yield* boot`SELECT value FROM settings WHERE ${boot("key")}='app_store_schema'`;
		const raw = rows[0]?.value;
		if (typeof raw !== "string") return yield* Effect.die("Missing bootstrap progress");
		const progress = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
			raw,
		);
		yield* boot`UPDATE settings SET value=${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({ ...progress, next: 0, active: "table:kernel_writer" })} WHERE ${boot("key")}='app_store_schema'`;
	}
	if (mode === "old-ladder") {
		yield* run();
		yield* app`DROP TABLE kernel_migration_intent`;
		const rows = yield* boot`SELECT value FROM settings WHERE ${boot("key")}='app_store_schema'`;
		const progress = yield* Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.String }))(rows[0]);
		const saved = yield* Schema.decodeEffect(
			Schema.fromJsonString(Schema.Struct({ operations: Schema.Array(Schema.String), next: Schema.Int })),
		)(progress.value);
		const original = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
			progress.value,
		);
		yield* boot`UPDATE settings SET value=${JSON.stringify({ ...original, operations: saved.operations.slice(0, -1), next: saved.next - 1 })} WHERE ${boot("key")}='app_store_schema'`;
	}
	if (mode === "missing-completed") {
		yield* run();
		yield* app`DROP TABLE outbox`;
	}
	const result = yield* run(
		mode === "wrong-adoption" ? { ...adoption, store_id: "00000000-0000-4000-8000-000000000000" } : adoption,
	).pipe(Effect.result);
	if (["foreign", "foreign-active", "ready", "missing-completed", "wrong-adoption", "old-ladder"].includes(mode)) {
		if (result._tag !== "Failure" || !Schema.is(EventError)(result.failure))
			return yield* Effect.die(
				`Expected an identity refusal: ${result._tag === "Failure" ? result.failure._tag : "success"}`,
			);
		return {
			code: result.failure.code,
			...(yield* snapshot),
			...(mode === "foreign-active"
				? { untouched: (yield* operator`SELECT epoch FROM kernel_writer WHERE singleton=1`)[0]?.epoch }
				: {}),
		};
	}
	if (result._tag === "Failure") return yield* result.failure;
	if (mode === "permissions") {
		yield* operator`INSERT INTO outbox(seq,transaction_id,event,shipped_at) VALUES(1,'fixture','{}',NULL)`;
		yield* operator`UPDATE outbox SET shipped_at=1 WHERE seq=1`;
		yield* operator`DELETE FROM outbox WHERE seq=1`;
		yield* operator`SELECT singleton,store_id FROM store_identity`;
		const mutation = yield* operator`UPDATE store_identity SET store_id='forbidden' WHERE singleton=1`.pipe(
			Effect.result,
		);
		if ((mutation._tag === "Failure") !== (engine === "pg"))
			return yield* Effect.die("Unexpected protected identity permission");
		yield* operator`CREATE TABLE owned_extension(value INTEGER)`;
		yield* operator`DROP TABLE owned_extension`;
		return { permissions: true, ...(yield* snapshot) };
	}
	return yield* snapshot;
}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(Reactivity.layer));
main.pipe(
	Effect.flatMap((value) => Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value)),
	Effect.flatMap(Console.log),
	BunRuntime.runMain,
);
