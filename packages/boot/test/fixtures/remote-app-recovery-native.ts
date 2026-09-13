import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Context, Crypto, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { advisoryClientLayer, directClientLayer } from "@comms/storage/remote-client";
import { type RemoteConnection } from "@comms/storage/remote-session";
import { parseDescriptor, type RemoteStore } from "@comms/storage/store";
import { remoteRecovery } from "../../src/app-recovery.ts";
import { remoteAppStoreIdentity } from "../../src/app-store-identity.ts";
import { EventError, layer as eventsLayer } from "../../src/events.ts";

// Independent fixture connections inspect and inject faults alongside recovery operations.
const open = (connection: RemoteConnection) =>
	Effect.map(Layer.build(directClientLayer({ connection })), (context) => Context.get(context, SqlClient.SqlClient));

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const reactivity = yield* Reactivity.Reactivity;
	const crypto = yield* Crypto.Crypto;
	const appPath = process.argv[2];
	const bootPath = process.argv[3];
	if (!appPath || !bootPath) return yield* Effect.die("Expected two disposable database config paths");
	const read = (path: string) =>
		fs.readFileString(path).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Settings))));
	const appConfig = yield* read(appPath);
	const bootConfig = yield* read(bootPath);
	if (
		appConfig.database !== "comms_recovery_app" ||
		bootConfig.database !== "comms_recovery_boot" ||
		appConfig.engine !== bootConfig.engine
	)
		return yield* Effect.die("Refusing non-disposable recovery databases");
	const connection = (config: typeof Settings.Type): RemoteConnection => ({
		...config,
		password: Redacted.make(config.password),
		tls: false,
	});
	const descriptor = (config: typeof Settings.Type) =>
		parseDescriptor(
			`${config.engine === "pg" ? "postgres" : "mysql"}://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}`,
		).pipe(
			Effect.flatMap((store) => (store._tag === "file" ? Effect.die("Expected remote store") : Effect.succeed(store))),
		);
	const appStore = yield* descriptor(appConfig);
	const bootStore = yield* descriptor(bootConfig);
	const boot = yield* open(connection(bootConfig));
	const app = yield* open(connection(appConfig));
	const engineSuffix =
		appConfig.engine === "mysql" ? " ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin" : "";
	for (const table of ["settings", "seq"]) yield* boot`DROP TABLE IF EXISTS ${boot(table)}`;
	yield* boot.unsafe(
		`CREATE TABLE settings (${appConfig.engine === "mysql" ? "`key`" : "key"} VARCHAR(256) PRIMARY KEY,value TEXT NOT NULL)${engineSuffix}`,
	);
	yield* boot.unsafe(
		`CREATE TABLE seq (singleton INTEGER PRIMARY KEY,next INTEGER NOT NULL,published_through INTEGER NOT NULL,pending_id VARCHAR(128),pending_attempt VARCHAR(128),pending_from INTEGER,pending_to INTEGER)${engineSuffix}`,
	);
	yield* boot`INSERT INTO seq VALUES(1,1,0,NULL,NULL,NULL,NULL)`;
	const reset = Effect.gen(function* () {
		for (const table of ["outbox", "mutation_batches", "kernel_writer", "store_identity"])
			yield* app`DROP TABLE IF EXISTS ${app(table)}`;
		yield* boot`DELETE FROM settings`;
		yield* boot`UPDATE seq SET pending_id=NULL,pending_attempt=NULL,pending_from=NULL,pending_to=NULL`;
	});
	const initialize = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql.unsafe(
			`CREATE TABLE IF NOT EXISTS store_identity(singleton INTEGER PRIMARY KEY,store_id VARCHAR(64) NOT NULL,initialized_at BIGINT NOT NULL,transferred_to TEXT)${engineSuffix}`,
		);
		yield* sql.unsafe(
			`CREATE TABLE IF NOT EXISTS kernel_writer(singleton INTEGER PRIMARY KEY,epoch VARCHAR(128) NOT NULL)${engineSuffix}`,
		);
		yield* sql.unsafe(
			`CREATE TABLE IF NOT EXISTS mutation_batches(id VARCHAR(128) PRIMARY KEY,from_seq BIGINT NOT NULL,to_seq BIGINT NOT NULL,count INTEGER NOT NULL)${engineSuffix}`,
		);
		yield* sql.unsafe(
			`CREATE TABLE IF NOT EXISTS outbox(seq BIGINT PRIMARY KEY,transaction_id VARCHAR(128) NOT NULL,event TEXT NOT NULL,shipped_at BIGINT)${engineSuffix}`,
		);
	});
	// This fixture tests durable recovery evidence through independent SQL sessions.
	const withStore = <A, E>(store: RemoteStore, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
		Effect.scoped(
			Effect.gen(function* () {
				assert.equal(store.database, appConfig.database);
				const sql = yield* open(connection(appConfig));
				return yield* effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
			}).pipe(Effect.provideService(Reactivity.Reactivity, reactivity), Effect.provideService(Crypto.Crypto, crypto)),
		);
	const proof = Effect.gen(function* () {
		const recovery = yield* remoteRecovery({
			appStore,
			bootStore,
			dataDirectory: "/unused",
			withStore,
			withWriter: (store, effect) =>
				Effect.scoped(
					Effect.gen(function* () {
						assert.equal(store.database, appConfig.database);
						const sql = Context.get(
							yield* Layer.build(advisoryClientLayer({ connection: connection(appConfig) })),
							SqlClient.SqlClient,
						);
						return yield* effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
					}).pipe(Effect.provideService(Reactivity.Reactivity, reactivity)),
				),
			initialize: () => initialize,
		});
		const identity = yield* remoteAppStoreIdentity(appStore);
		yield* reset;
		const reserved = yield* identity.reserve;
		assert.equal((yield* identity.reserve).store_id, reserved.store_id);
		yield* recovery.prepare("initial");
		const adopted = yield* app`SELECT store_id FROM store_identity`;
		assert.equal(adopted[0]?.store_id, reserved.store_id);
		assert.equal((yield* identity.store).database, appConfig.database);
		const before = yield* app`SELECT singleton,epoch FROM kernel_writer`;
		yield* recovery.checkSchema;
		assert.deepEqual(yield* app`SELECT singleton,epoch FROM kernel_writer`, before);
		assert.deepEqual(yield* app`SELECT store_id FROM store_identity`, adopted);
		// An actual missing table aborts PostgreSQL's savepoint; the outer writer fence must still commit.
		yield* app`DROP TABLE mutation_batches`;
		assert.equal((yield* recovery.checkSchema.pipe(Effect.result))._tag, "Failure");
		yield* boot`UPDATE seq SET next=3,pending_id='tx',pending_attempt='initial',pending_from=1,pending_to=1`;
		const damaged = yield* recovery.prepare("fenced-after-damage").pipe(Effect.result);
		assert.equal(damaged._tag, "Failure");
		assert.equal((yield* app`SELECT epoch FROM kernel_writer`)[0]?.epoch, "fenced-after-damage");
		assert.equal((yield* boot`SELECT pending_id FROM seq`)[0]?.pending_id, "tx");
		for (const kind of ["missing", "foreign", "transferred", "missing-table"]) {
			yield* reset;
			yield* recovery.prepare("before-refusal");
			if (kind === "missing") yield* app`DELETE FROM store_identity`;
			if (kind === "foreign") yield* app`UPDATE store_identity SET store_id='11111111-1111-4111-8111-111111111111'`;
			if (kind === "transferred") yield* app`UPDATE store_identity SET transferred_to='target'`;
			if (kind === "missing-table") yield* app`DROP TABLE store_identity`;
			assert.equal((yield* recovery.checkSchema.pipe(Effect.result))._tag, "Failure");
			const refused = yield* recovery.prepare("must-not-fence").pipe(Effect.result);
			assert.equal(refused._tag, "Failure");
			assert(refused._tag === "Failure" && Schema.is(EventError)(refused.failure));
			assert.equal(
				refused.failure.code,
				kind === "transferred" ? "store_transferred" : kind === "foreign" ? "app_store_mismatch" : "app_store_missing",
			);
			assert.equal((yield* app`SELECT epoch FROM kernel_writer`)[0]?.epoch, "before-refusal");
			if (kind === "foreign")
				assert.equal(
					(yield* app`SELECT store_id FROM store_identity`)[0]?.store_id,
					"11111111-1111-4111-8111-111111111111",
				);
		}
		yield* reset;
		yield* recovery.prepare("same-epoch");
		yield* recovery.prepare("same-epoch");
		assert.equal((yield* app`SELECT epoch FROM kernel_writer`)[0]?.epoch, "same-epoch");
		return { engine: appConfig.engine, passed: 7 };
	}).pipe(Effect.provide(eventsLayer(Effect.void)), Effect.provideService(SqlClient.SqlClient, boot));
	return yield* proof;
}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(Reactivity.layer));
main.pipe(
	Effect.flatMap((result) => Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)),
	Effect.flatMap(Console.log),
	BunRuntime.runMain,
);
