import { assertTransferState } from "./store-transfer-state.ts";
import { on } from "@comms/storage/dialect";
import { asBoot, type RemoteStore } from "@comms/storage/store";
import { Effect, Option, Redacted, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { replayAppKernel } from "./app-kernel-replay.ts";
import { remoteAppKernelOperations } from "./app-kernel-schema.ts";
import { RemoteAdoption } from "./app-store-identity.ts";
import { lockBootWrite } from "./boot-write-lock.ts";
import { decodeRows } from "./decode-rows.ts";
import { EventError } from "./events.ts";

const Progress = Schema.Struct({
	store_id: Schema.String,
	initialized_at: Schema.Int,
	engine: Schema.Literals(["postgres", "mysql"]),
	database: Schema.String,
	principal: Schema.String,
	operations: Schema.Array(Schema.String),
	next: Schema.Int,
	active: Schema.NullOr(Schema.String),
});
type Progress = typeof Progress.Type;
const invalid = () => new EventError({ code: "app_store_identity_invalid" });

/** Capture the boot store, then run each initialization inside the root-owned guarded app scope.
 * Progress stays in boot's existing settings; no editable app ledger can establish DDL ownership. */
export const makeRemoteAppInitializer = (options: {
	readonly appStore: RemoteStore;
	readonly bootStore: RemoteStore;
}) =>
	Effect.gen(function* () {
		const boot = yield* SqlClient.SqlClient;
		const gate = yield* Semaphore.make(1);
		yield* asBoot(options.appStore, options.bootStore);
		const principal = yield* Effect.try({
			try: () => decodeURIComponent(new URL(Redacted.value(options.appStore.url)).username),
			catch: invalid,
		});
		const bootPrincipal = yield* Effect.try({
			try: () => decodeURIComponent(new URL(Redacted.value(options.bootStore.url)).username),
			catch: invalid,
		});
		if (!principal || !bootPrincipal || principal === bootPrincipal) return yield* invalid();
		return (adoption: RemoteAdoption) =>
			gate.withPermit(
				Effect.gen(function* () {
					const app = yield* SqlClient.SqlClient;
					const engine = on(app, { sqlite: () => "sqlite", pg: () => "postgres", mysql: () => "mysql" });
					if (engine !== adoption.engine) return yield* invalid();
					if (
						Option.isSome(yield* Effect.serviceOption(boot.transactionService)) ||
						Option.isSome(yield* Effect.serviceOption(app.transactionService)) ||
						adoption.phase !== "pending" ||
						adoption.engine !== options.appStore._tag ||
						!Number.isSafeInteger(adoption.initialized_at) ||
						adoption.initialized_at < 0 ||
						!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(adoption.store_id)
					)
						return yield* invalid();
					const operations = remoteAppKernelOperations(app, principal);
					const names = operations.map((operation) => operation.name);
					const sameAdoption = (saved: RemoteAdoption) =>
						saved.phase === "pending" &&
						saved.store_id === adoption.store_id &&
						saved.initialized_at === adoption.initialized_at &&
						saved.engine === adoption.engine &&
						saved.database === adoption.database;
					// Each call commits before any app SQL. No app connection is borrowed inside this transaction.
					const transaction = <A, E>(work: (progress: Progress | undefined) => Effect.Effect<A, E>) =>
						boot.withTransaction(
							Effect.gen(function* () {
								yield* lockBootWrite(boot);
								const rows =
									yield* boot`SELECT ${boot("key")},value FROM settings WHERE ${boot("key")} IN ('app_store_adoption','app_store_schema','app_store_id','app_store_initialized','app_store_database','transferred_to','transfer_state')`.pipe(
										decodeRows(Schema.Struct({ key: Schema.String, value: Schema.String })),
									);
								const value = (key: string) => rows.find((row) => row.key === key)?.value;
								yield* assertTransferState(rows);
								const raw = value("app_store_adoption");
								if (
									raw === undefined ||
									value("app_store_id") !== undefined ||
									value("app_store_initialized") !== undefined ||
									value("app_store_database") !== undefined
								)
									return yield* invalid();
								const saved = yield* Schema.decodeEffect(Schema.fromJsonString(RemoteAdoption))(raw).pipe(
									Effect.mapError(invalid),
								);
								if (!sameAdoption(saved)) return yield* invalid();
								const encoded = value("app_store_schema");
								const progress =
									encoded === undefined
										? undefined
										: yield* Schema.decodeEffect(Schema.fromJsonString(Progress))(encoded).pipe(
												Effect.mapError(invalid),
											);
								if (
									progress &&
									(progress.store_id !== adoption.store_id ||
										progress.initialized_at !== adoption.initialized_at ||
										progress.engine !== adoption.engine ||
										progress.database !== adoption.database ||
										progress.principal !== principal ||
										progress.operations.length !== names.length ||
										progress.operations.some((name, index) => name !== names[index]) ||
										progress.next < 0 ||
										progress.next > names.length ||
										(progress.active !== null && progress.active !== names[progress.next]))
								)
									return yield* invalid();
								return yield* work(progress);
							}),
						);
					const progress = yield* transaction((progress) => Effect.succeed(progress));
					yield* replayAppKernel({
						app,
						principal,
						bootPrincipal,
						databaseName: adoption.database,
						bootDatabase: options.bootStore.database,
						progress,
						validate: transaction(() => Effect.void),
						initialize: transaction((existing) =>
							Effect.gen(function* () {
								if (existing) return yield* invalid();
								const initial: Progress = { ...adoption, principal, operations: names, next: 0, active: null };
								yield* boot`INSERT INTO settings(${boot("key")},value) VALUES('app_store_schema',${Schema.encodeSync(Schema.fromJsonString(Progress))(initial)})`;
								return initial;
							}),
						),
						checkpoint: (index, prior, active) =>
							transaction((saved) =>
								Effect.gen(function* () {
									if (!saved || saved.next !== index || saved.active !== prior) return yield* invalid();
									const next = { ...saved, next: active === null ? index + 1 : index, active };
									yield* boot`UPDATE settings SET value=${Schema.encodeSync(Schema.fromJsonString(Progress))(next)} WHERE ${boot("key")}='app_store_schema'`;
									return next;
								}),
							),
					});
				}).pipe(
					Effect.mapError((error) =>
						error._tag === "SchemaShapeError" || error._tag === "SchemaError" ? invalid() : error,
					),
				),
			);
	});
