import { withDatabase } from "@comms/storage/store";
import { Reactivity } from "effect/unstable/reactivity";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Redacted, Schema, Stream } from "effect";
import { SqlClient, Statement } from "effect/unstable/sql";
import { SqlError, SqlSyntaxError } from "effect/unstable/sql/SqlError";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { remoteRecovery } from "../../src/app-recovery.ts";
import { remoteAppStoreIdentity } from "../../src/app-store-identity.ts";
import { Events, EventError, layer as eventsLayer } from "../../src/events.ts";

const scenario = process.argv[2] ?? "fresh";
const dialect = scenario.startsWith("mysql") ? "mysql" : "pg";
const engine = dialect === "pg" ? "postgres" : "mysql";
const configured = {
	_tag: engine,
	url: Redacted.make(`${engine}://app@example.test/configured`),
	database: "configured",
} as const;
const bootStore = { _tag: engine, url: Redacted.make(`${engine}://boot@example.test/boot`), database: "boot" } as const;
const main = Effect.gen(function* () {
	yield* initializeBootSchema;
	const boot = yield* SqlClient.SqlClient;
	const events = yield* Events;
	const identity = yield* remoteAppStoreIdentity(configured);
	const adoption = yield* identity.reserve;
	const resumed = yield* identity.reserve;
	if (scenario === "fresh") {
		yield* identity.complete(adoption);
		const target = yield* withDatabase(configured, "restored");
		const outside = yield* identity.selectRestored(target).pipe(Effect.result);
		if (outside._tag !== "Failure") return yield* Effect.die("Selection escaped boot transaction");
		yield* boot.withTransaction(identity.selectRestored(target));
		return {
			same: adoption.store_id === resumed.store_id,
			selected: (yield* identity.store).database,
			phase: "ready",
		};
	}
	const commands: string[] = [];
	let appIdentity:
		| { singleton: number; store_id: string; initialized_at: number; transferred_to: string | null }
		| undefined;
	let writer: string | undefined;
	let committedWriter: string | undefined;
	const ready = !scenario.includes("pending");
	if (ready) {
		yield* identity.complete(adoption);
		appIdentity = {
			singleton: 1,
			store_id: adoption.store_id,
			initialized_at: adoption.initialized_at,
			transferred_to: null,
		};
		writer = "old";
	}
	if (scenario.includes("foreign"))
		appIdentity = { singleton: 1, store_id: "foreign", initialized_at: adoption.initialized_at, transferred_to: null };
	if (scenario.includes("missing")) appIdentity = undefined;
	if (scenario.includes("transferred"))
		appIdentity = {
			singleton: 1,
			store_id: adoption.store_id,
			initialized_at: adoption.initialized_at,
			transferred_to: "retired",
		};
	if (scenario.includes("missing-writer")) {
		appIdentity = {
			singleton: 1,
			store_id: adoption.store_id,
			initialized_at: adoption.initialized_at,
			transferred_to: null,
		};
		writer = undefined;
	}
	if (scenario.includes("boot-transfer"))
		yield* boot`INSERT INTO settings(key,value) VALUES('transfer_state','in_progress')`;
	if (scenario.includes("journal-mismatch"))
		yield* boot`UPDATE settings SET value='other' WHERE key='app_store_database'`;
	if (scenario.includes("evidence")) yield* events.reserve("tx", 1, "old");
	const execute = (text: string, params: ReadonlyArray<unknown>) =>
		Effect.gen(function* () {
			commands.push(text);
			if (text.includes("information_schema.tables")) return [{ table_name: "store_identity" }];
			if (text.startsWith("SELECT singleton,store_id")) return appIdentity ? [appIdentity] : [];
			if (text.startsWith("INSERT INTO store_identity")) {
				const [id, at] = params;
				if (typeof id !== "string" || typeof at !== "number")
					return yield* Effect.die("Unexpected identity parameters");
				appIdentity = { singleton: 1, store_id: id, initialized_at: at, transferred_to: null };
			}
			if (text.startsWith("SELECT singleton,epoch")) return writer ? [{ singleton: 1, epoch: writer }] : [];
			if (text.startsWith("INSERT INTO kernel_writer") || text.startsWith("UPDATE kernel_writer")) {
				if (typeof params[0] !== "string") return yield* Effect.die("Unexpected epoch");
				writer = params[0];
			}
			if (text.includes("FROM mutation_batches"))
				return yield* new SqlError({ reason: new SqlSyntaxError({ cause: "missing receipt table" }) });
			if (text === "COMMIT") committedWriter = writer;
			return [];
		});
	const app = yield* SqlClient.make({
		acquirer: Effect.succeed({
			execute,
			executeRaw: execute,
			executeUnprepared: execute,
			executeValues: () => Effect.succeed([]),
			executeValuesUnprepared: () => Effect.succeed([]),
			executeStream: () => Stream.empty,
		}),
		compiler: Statement.makeCompiler({
			dialect,
			placeholder: () => "?",
			onIdentifier: (value) => value,
			onRecordUpdate: () => {
				throw new Error("Unused");
			},
			onCustom: () => {
				throw new Error("Unused");
			},
		}),
		spanAttributes: [],
	});
	const recovery = yield* remoteRecovery({
		appStore: configured,
		bootStore,
		dataDirectory: "/unused",
		authorizeStoreAccess: (store) =>
			Effect.gen(function* () {
				commands.push(`authorize:${store.database}`);
				if (scenario.includes("denied")) return yield* new EventError({ code: "app_store_missing" });
			}),
		withStore: (store, effect) =>
			Effect.gen(function* () {
				commands.push(`open:${store.database}`);
				const saved = yield* boot`SELECT value FROM settings WHERE key='app_store_adoption'`;
				if (saved.length !== 1) return yield* Effect.die("Opened before UUID reservation");
				return yield* effect.pipe(
					Effect.provideService(SqlClient.SqlClient, app),
					Effect.ensuring(Effect.sync(() => commands.push("closed"))),
				);
			}),
		initialize: () =>
			Effect.sync(() => {
				commands.push("initialize");
			}),
	});
	const result = yield* recovery.prepare("new").pipe(Effect.result);
	return {
		result,
		commands,
		committedWriter,
		adoption: yield* boot`SELECT value FROM settings WHERE key='app_store_adoption'`,
	};
}).pipe(
	Effect.provide(eventsLayer(Effect.void)),
	Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
	Effect.scoped,
	Effect.provide(BunServices.layer),
	Effect.provide(Reactivity.layer),
);
main.pipe(
	Effect.flatMap((value) => Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value)),
	Effect.flatMap(Console.log),
	BunRuntime.runMain,
);
