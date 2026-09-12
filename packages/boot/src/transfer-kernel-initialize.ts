import { on } from "@comms/storage/dialect";
import { asBoot, type Store } from "@comms/storage/store";
import {
	selectionText,
	TransferRejected,
	TransferSelection,
	validateTransferSelection,
} from "@comms/storage/store-transfer-schema";
import { Effect, Option, Redacted, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { replayAppKernel } from "./app-kernel-replay.ts";
import { remoteAppKernelOperations } from "./app-kernel-schema.ts";
import { lockBootWrite } from "./boot-write-lock.ts";
import { decodeRows } from "./decode-rows.ts";

const Progress = Schema.Struct({
	selection: TransferSelection,
	initialized_at: Schema.Int,
	epoch: Schema.String,
	principal: Schema.String,
	operations: Schema.Array(Schema.String),
	next: Schema.Int,
	active: Schema.NullOr(Schema.String),
	seeded: Schema.Boolean,
});
type Progress = typeof Progress.Type;
const rejected = () => new TransferRejected({ code: "transfer_journal_conflict" });

/** Offline preparation only. Both clients are caller-owned; remote app access must use boot's guarded principal. */
export const makeTransferKernelInitializer = (stores: { readonly appStore: Store; readonly bootStore: Store }) =>
	Effect.gen(function* () {
		const boot = yield* SqlClient.SqlClient;
		const gate = yield* Semaphore.make(1);
		const appStore = stores.appStore;
		const bootStore = stores.bootStore;
		if ((appStore._tag === "file") !== (bootStore._tag === "file")) return yield* rejected();
		const credentials = yield* Effect.try({
			try: () => {
				if (appStore._tag === "file" || bootStore._tag === "file")
					return { principal: "", bootPrincipal: "", endpoint: null };
				const app = new URL(Redacted.value(appStore.url));
				const boot = new URL(Redacted.value(bootStore.url));
				return {
					principal: decodeURIComponent(app.username),
					bootPrincipal: decodeURIComponent(boot.username),
					endpoint: `${app.hostname}:${app.port || (appStore._tag === "postgres" ? "5432" : "3306")}`,
				};
			},
			catch: rejected,
		});
		if (appStore._tag !== "file" && bootStore._tag !== "file") {
			yield* asBoot(appStore, bootStore);
			if (!credentials.principal || !credentials.bootPrincipal || credentials.principal === credentials.bootPrincipal)
				return yield* rejected();
		}
		return (selected: TransferSelection, seed: { readonly initialized_at: number; readonly epoch: string }) =>
			gate.withPermit(
				Effect.gen(function* () {
					const selection = yield* validateTransferSelection(selected);
					const app = yield* SqlClient.SqlClient;
					const engine = on(app, { sqlite: () => "sqlite", pg: () => "pg", mysql: () => "mysql" });
					const databaseName = appStore._tag === "file" ? appStore.filename : appStore.database;
					const bootDatabase = bootStore._tag === "file" ? bootStore.filename : bootStore.database;
					if (
						engine !== selection.target.engine ||
						selection.target.app !== databaseName ||
						selection.target.boot !== bootDatabase ||
						selection.target.endpoint !== credentials.endpoint ||
						!Number.isSafeInteger(seed.initialized_at) ||
						seed.initialized_at < 0 ||
						!seed.epoch ||
						seed.epoch.length > 128 ||
						Option.isSome(yield* Effect.serviceOption(app.transactionService)) ||
						Option.isSome(yield* Effect.serviceOption(boot.transactionService))
					)
						return yield* rejected();
					if (appStore._tag === "file") {
						const files = yield* app`PRAGMA database_list`.pipe(
							decodeRows(Schema.Struct({ name: Schema.String, file: Schema.String })),
						);
						const bootFiles = yield* boot`PRAGMA database_list`.pipe(
							decodeRows(Schema.Struct({ name: Schema.String, file: Schema.String })),
						);
						if (
							files.find((file) => file.name === "main")?.file !== databaseName ||
							bootFiles.find((file) => file.name === "main")?.file !== bootDatabase
						)
							return yield* rejected();
					} else {
						const actual = yield* on(app, {
							sqlite: () => {
								throw new Error("Expected remote client");
							},
							pg: () => app`SELECT current_database() AS name,session_user AS principal,current_user AS effective`,
							mysql: () =>
								app`SELECT DATABASE() AS name,SUBSTRING_INDEX(CURRENT_USER(),'@',1) AS principal,SUBSTRING_INDEX(CURRENT_USER(),'@',1) AS effective`,
						}).pipe(
							decodeRows(Schema.Struct({ name: Schema.String, principal: Schema.String, effective: Schema.String })),
						);
						if (
							actual.length !== 1 ||
							actual[0]?.name !== databaseName ||
							actual[0]?.principal !== credentials.bootPrincipal ||
							actual[0]?.effective !== credentials.bootPrincipal
						)
							return yield* rejected();
						const selectedBoot = yield* on(boot, {
							sqlite: () => {
								throw new Error("Expected remote boot");
							},
							pg: () => boot`SELECT current_database() AS name,session_user AS principal,current_user AS effective`,
							mysql: () =>
								boot`SELECT DATABASE() AS name,SUBSTRING_INDEX(CURRENT_USER(),'@',1) AS principal,SUBSTRING_INDEX(CURRENT_USER(),'@',1) AS effective`,
						}).pipe(
							decodeRows(Schema.Struct({ name: Schema.String, principal: Schema.String, effective: Schema.String })),
						);
						if (
							selectedBoot.length !== 1 ||
							selectedBoot[0]?.name !== bootDatabase ||
							selectedBoot[0]?.principal !== credentials.bootPrincipal ||
							selectedBoot[0]?.effective !== credentials.bootPrincipal
						)
							return yield* rejected();
					}
					const names = remoteAppKernelOperations(app, credentials.principal).map((operation) => operation.name);
					const initial: Progress = {
						selection,
						...seed,
						principal: credentials.principal,
						operations: names,
						next: 0,
						active: null,
						seeded: false,
					};
					const transaction = <A, E>(work: (progress: Progress | undefined) => Effect.Effect<A, E>) =>
						boot.withTransaction(
							Effect.gen(function* () {
								yield* lockBootWrite(boot);
								const rows =
									yield* boot`SELECT ${boot("key")},value FROM settings WHERE ${boot("key")} IN ('transfer_state','transfer_prepare','transfer_kernel','transferred_to','app_store_id','app_store_initialized','app_store_database','app_store_adoption')`.pipe(
										decodeRows(Schema.Struct({ key: Schema.String, value: Schema.String })),
									);
								const value = (key: string) => rows.find((row) => row.key === key)?.value;
								if (
									value("transfer_state") !== "in_progress" ||
									value("transferred_to") !== undefined ||
									value("app_store_id") !== undefined ||
									value("app_store_initialized") !== undefined ||
									value("app_store_database") !== undefined ||
									value("app_store_adoption") !== undefined
								)
									return yield* rejected();
								const prepare = yield* Schema.decodeEffect(Schema.fromJsonString(TransferSelection))(
									value("transfer_prepare") ?? "",
								).pipe(Effect.mapError(rejected));
								if (selectionText(prepare) !== selectionText(selection)) return yield* rejected();
								const raw = value("transfer_kernel");
								const progress =
									raw === undefined
										? undefined
										: yield* Schema.decodeEffect(Schema.fromJsonString(Progress))(raw).pipe(Effect.mapError(rejected));
								if (
									progress &&
									(selectionText(progress.selection) !== selectionText(selection) ||
										progress.initialized_at !== seed.initialized_at ||
										progress.epoch !== seed.epoch ||
										progress.principal !== credentials.principal ||
										progress.operations.length !== names.length ||
										progress.operations.some((name, index) => name !== names[index]) ||
										progress.next < 0 ||
										progress.next > names.length ||
										(progress.active !== null && progress.active !== names[progress.next]) ||
										(progress.seeded && (progress.next !== names.length || progress.active !== null)))
								)
									return yield* rejected();
								return yield* work(progress);
							}),
						);
					const save = (progress: Progress) =>
						boot`UPDATE settings SET value=${Schema.encodeSync(Schema.fromJsonString(Progress))(progress)} WHERE ${boot("key")}='transfer_kernel'`.pipe(
							Effect.as(progress),
						);
					const progress = yield* transaction((saved) =>
						Effect.gen(function* () {
							if (saved) return saved;
							yield* boot`INSERT INTO settings(${boot("key")},value) VALUES('transfer_kernel',${Schema.encodeSync(Schema.fromJsonString(Progress))(initial)})`;
							return initial;
						}),
					);
					const identity = Effect.gen(function* () {
						const rows = yield* app`SELECT singleton,store_id,initialized_at,transferred_to FROM store_identity`.pipe(
							decodeRows(
								Schema.Struct({
									singleton: Schema.Int,
									store_id: Schema.String,
									initialized_at: Schema.Int,
									transferred_to: Schema.NullOr(Schema.String),
								}),
							),
						);
						const writers = yield* app`SELECT singleton,epoch FROM kernel_writer`.pipe(
							decodeRows(Schema.Struct({ singleton: Schema.Int, epoch: Schema.String })),
						);
						if (
							rows.length !== 1 ||
							rows[0]?.singleton !== 1 ||
							rows[0]?.store_id !== selection.store_id ||
							rows[0]?.initialized_at !== seed.initialized_at ||
							rows[0]?.transferred_to !== null ||
							writers.length !== 1 ||
							writers[0]?.singleton !== 1 ||
							writers[0]?.epoch !== seed.epoch
						)
							return yield* rejected();
					});

					if (progress.seeded) {
						yield* identity;
						return;
					}
					if (appStore._tag === "file") {
						yield* transaction(() => Effect.void);
						yield* app.withTransaction(
							Effect.gen(function* () {
								const statements = [
									"CREATE TABLE kernel_writer (singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL)",
									"CREATE TABLE mutation_batches (id TEXT PRIMARY KEY,from_seq INTEGER NOT NULL,to_seq INTEGER NOT NULL,count INTEGER NOT NULL)",
									"CREATE TABLE outbox (seq INTEGER PRIMARY KEY,transaction_id TEXT NOT NULL,event TEXT NOT NULL,shipped_at INTEGER)",
									"CREATE TABLE store_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id TEXT NOT NULL,initialized_at INTEGER NOT NULL,transferred_to TEXT)",
								];
								const catalog = yield* app`SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`.pipe(
									decodeRows(Schema.Struct({ sql: Schema.NullOr(Schema.String) })),
								);
								if (catalog.length === 0) {
									for (const statement of statements) yield* app.unsafe(statement);
									yield* app`INSERT INTO store_identity VALUES(1,${selection.store_id},${seed.initialized_at},NULL)`;
									yield* app`INSERT INTO kernel_writer VALUES(1,${seed.epoch})`;
								} else if (
									catalog.length !== statements.length ||
									catalog.some((row) => row.sql === null || !statements.includes(row.sql))
								)
									return yield* rejected();
								yield* identity;
							}),
						);
					} else {
						yield* replayAppKernel({
							app,
							...credentials,
							databaseName,
							bootDatabase,
							progress,
							validate: transaction(() => Effect.void),
							initialize: Effect.succeed(progress),
							checkpoint: (index, prior, active) =>
								transaction((saved) =>
									Effect.gen(function* () {
										if (!saved || saved.next !== index || saved.active !== prior || saved.seeded)
											return yield* rejected();
										return yield* save({ ...saved, next: active === null ? index + 1 : index, active });
									}),
								),
						});
						yield* transaction(() => Effect.void);
						yield* app.withTransaction(
							Effect.gen(function* () {
								const existing = yield* app`SELECT singleton FROM store_identity`;
								const writers = yield* app`SELECT singleton FROM kernel_writer`;
								if (existing.length === 0 && writers.length === 0) {
									yield* app`INSERT INTO store_identity(singleton,store_id,initialized_at,transferred_to) VALUES(1,${selection.store_id},${seed.initialized_at},NULL)`;
									yield* app`INSERT INTO kernel_writer(singleton,epoch) VALUES(1,${seed.epoch})`;
								}
								yield* identity;
							}),
						);
					}
					yield* transaction((saved) =>
						Effect.gen(function* () {
							if (!saved || saved.next !== names.length || saved.active !== null) return yield* rejected();
							return yield* save({ ...saved, seeded: true });
						}),
					);
				}),
			);
	});
