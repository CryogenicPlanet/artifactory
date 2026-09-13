import { on } from "@comms/storage/dialect";
import { asBoot, type RemoteStore } from "@comms/storage/store";
import { Effect, Option, Redacted, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
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
								if (value("transferred_to") !== undefined) return yield* new EventError({ code: "store_transferred" });
								if (value("transfer_state") !== undefined && value("transfer_state") !== "complete")
									return yield* new EventError({ code: "store_transfer_incomplete" });
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
					let progress = yield* transaction((progress) => Effect.succeed(progress));
					const database = yield* on(app, {
						sqlite: () => {
							throw new Error("Expected a remote app client");
						},
						pg: () => app`SELECT current_database() AS name`,
						mysql: () => app`SELECT DATABASE() AS name`,
					}).pipe(decodeRows(Schema.Struct({ name: Schema.String })));
					if (
						database.length !== 1 ||
						database[0]?.name !== adoption.database ||
						adoption.database === options.bootStore.database
					)
						return yield* invalid();
					yield* on(app, {
						sqlite: () => {
							throw new Error("Expected a remote app client");
						},
						pg: () =>
							Effect.gen(function* () {
								const rows =
									yield* app`SELECT current_user AS name,session_user AS session,NOT pg_has_role(${principal}::name,d.datdba,'MEMBER') AS database_ok,NOT pg_has_role(${principal}::name,n.nspowner,'MEMBER') AS schema_ok,NOT pg_has_role(${principal}::name,${bootPrincipal}::name,'MEMBER') AS role_ok FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_namespace n WHERE d.datname=current_database() AND n.nspname='public'`.pipe(
										decodeRows(
											Schema.Struct({
												name: Schema.String,
												session: Schema.String,
												database_ok: Schema.Boolean,
												schema_ok: Schema.Boolean,
												role_ok: Schema.Boolean,
											}),
										),
									);
								if (
									rows.length !== 1 ||
									rows[0]?.name !== bootPrincipal ||
									rows[0]?.session !== bootPrincipal ||
									!rows[0]?.database_ok ||
									!rows[0]?.schema_ok ||
									!rows[0]?.role_ok
								)
									return yield* invalid();
							}).pipe(Effect.asVoid),
						mysql: () => Effect.void,
					});
					const catalog = yield* on(app, {
						sqlite: () => {
							throw new Error("Expected a remote app client");
						},
						pg: () =>
							app`SELECT c.relname AS name,n.nspname AS namespace,CASE WHEN pg_get_userbyid(c.relowner)=current_user THEN 1 ELSE 0 END AS owned FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT starts_with(n.nspname::text,'pg_toast') AND NOT starts_with(n.nspname::text,'pg_temp_') AND c.relkind IN ('r','p','v','m','f')`,
						mysql: () =>
							app`SELECT TABLE_NAME AS name,'public' AS namespace,1 AS owned FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE()`,
					}).pipe(decodeRows(Schema.Struct({ name: Schema.String, namespace: Schema.String, owned: Schema.Int })));
					const owned = progress
						? names
								.slice(0, progress.next + (progress.active === null ? 0 : 1))
								.filter((name) => name.startsWith("table:"))
								.map((name) => name.slice(6))
						: [];
					if (catalog.some((table) => table.namespace !== "public" || table.owned !== 1 || !owned.includes(table.name)))
						return yield* invalid();
					if (!progress) {
						const initial: Progress = { ...adoption, principal, operations: names, next: 0, active: null };
						progress = yield* transaction((existing) =>
							Effect.gen(function* () {
								if (existing) return yield* invalid();
								yield* boot`INSERT INTO settings(${boot("key")},value) VALUES('app_store_schema',${Schema.encodeSync(Schema.fromJsonString(Progress))(initial)})`;
								return initial;
							}),
						);
					}
					for (let index = 0; index < progress.next; index++) {
						const operation = operations[index];
						if (!operation || !(yield* operation.postcondition)) return yield* invalid();
					}
					for (let index = progress.next; index < operations.length; index++) {
						const operation = operations[index];
						if (!operation) return yield* invalid();
						const complete = yield* operation.postcondition;
						if (progress.active === null) {
							if (complete && !operation.name.startsWith("grant:")) return yield* invalid();
							progress = yield* transaction((saved) =>
								Effect.gen(function* () {
									if (!saved || saved.next !== index || saved.active !== null) return yield* invalid();
									const active = { ...saved, active: operation.name };
									yield* boot`UPDATE settings SET value=${Schema.encodeSync(Schema.fromJsonString(Progress))(active)} WHERE ${boot("key")}='app_store_schema'`;
									return active;
								}),
							);
						}
						const apply = Effect.gen(function* () {
							if (!complete) yield* operation.run;
							if (!(yield* operation.postcondition)) return yield* invalid();
						});
						yield* on(app, {
							sqlite: () => {
								throw new Error("Expected a remote app client");
							},
							pg: () => app.withTransaction(apply),
							mysql: () => apply,
						});
						progress = yield* transaction((saved) =>
							Effect.gen(function* () {
								if (!saved || saved.next !== index || saved.active !== operation.name) return yield* invalid();
								const advanced = { ...saved, next: index + 1, active: null };
								yield* boot`UPDATE settings SET value=${Schema.encodeSync(Schema.fromJsonString(Progress))(advanced)} WHERE ${boot("key")}='app_store_schema'`;
								return advanced;
							}),
						);
					}
				}).pipe(
					Effect.mapError((error) =>
						error._tag === "SchemaShapeError" || error._tag === "SchemaError" ? invalid() : error,
					),
				),
			);
	});
