import { on } from "@comms/storage/dialect";
import type { Store } from "@comms/storage/store";
import {
	selectionText,
	transferProtocol,
	TransferRejected,
	TransferPreparation,
} from "@comms/storage/store-transfer-schema";
import { Effect, FileSystem, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "./boot-schema.ts";
import { lockBootWrite } from "./boot-write-lock.ts";
import { decodeRows } from "./decode-rows.ts";
import { bindTransferTarget } from "./transfer-target.ts";
import { assertTransferSentinel, reserveTransferSentinel } from "./transfer-sentinel.ts";

const rejected = () => new TransferRejected({ code: "transfer_journal_conflict" });

/** Capture guarded boot SQL. Verify the shared durable preparation before target DDL,
 * and its ready transition before this helper can create any boot table. */
export const makeTransferBootstrap = (stores: { readonly appStore: Store; readonly bootStore: Store }) =>
	Effect.gen(function* () {
		const boot = yield* SqlClient.SqlClient;
		return <E, R>(preparation: TransferPreparation, markReady: Effect.Effect<void, E, R>) =>
			Effect.gen(function* () {
				const app = yield* SqlClient.SqlClient;
				const { selection, appStore, credentials } = yield* bindTransferTarget(
					stores,
					boot,
					app,
					preparation.selection,
					preparation,
				);
				if (preparation.phase !== "preparing" || !["pending", "ready"].includes(preparation.sentinel))
					return yield* rejected();
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const receipt = (sentinel: TransferPreparation["sentinel"]) =>
					Effect.gen(function* () {
						const directory = path.join(selection.data_directory, "transfers", selection.transfer_id);
						const filename = path.join(directory, "journal.json");
						for (const name of [selection.data_directory, directory, filename])
							if ((yield* fs.realPath(name)) !== name) return yield* rejected();
						if ((yield* fs.stat(filename)).type !== "File") return yield* rejected();
						const saved = yield* fs
							.readFileString(filename)
							.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TransferPreparation))));
						if (
							selectionText(saved.selection) !== selectionText(selection) ||
							saved.epoch !== preparation.epoch ||
							saved.initialized_at !== preparation.initialized_at ||
							saved.sentinel !== sentinel
						)
							return yield* rejected();
						// The readback is an acknowledged durable prerequisite, not a staged .next file.
						for (const name of [filename, directory, path.dirname(directory), selection.data_directory])
							yield* Effect.scoped(fs.open(name).pipe(Effect.flatMap((file) => file.sync)));
					}).pipe(Effect.mapError(rejected));
				yield* receipt(preparation.sentinel);
				const read = Effect.gen(function* () {
					const exists = yield* on(boot, {
						sqlite: () => boot`SELECT name FROM sqlite_master WHERE name='settings' AND type='table'`,
						pg: () =>
							boot`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='settings' AND c.relkind='r'`,
						mysql: () =>
							boot`SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='settings' AND TABLE_TYPE='BASE TABLE'`,
					});
					if (exists.length === 0) return false;
					const rows =
						yield* boot`SELECT ${boot("key")},value FROM settings WHERE ${boot("key")} IN ('transfer_state','transfer_prepare','transferred_to','app_store_id','app_store_initialized','app_store_database','app_store_adoption','app_store_schema')`.pipe(
							decodeRows(Schema.Struct({ key: Schema.String, value: Schema.String })),
						);
					if (rows.some((row) => !["transfer_state", "transfer_prepare"].includes(row.key))) return yield* rejected();
					const state = rows.find((row) => row.key === "transfer_state")?.value;
					const prepare = rows.find((row) => row.key === "transfer_prepare")?.value;
					if (state === undefined && prepare === undefined) return false;
					if (state !== "in_progress" || prepare !== selectionText(selection)) return yield* rejected();
					return true;
				});
				if (preparation.sentinel === "pending") {
					const tables = yield* on(boot, {
						sqlite: () => boot`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`,
						pg: () =>
							boot`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')`,
						mysql: () => boot`SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE()`,
					});
					if (tables.length) return yield* rejected();
				}
				const guarded = yield* read;
				if (guarded) {
					if (preparation.sentinel !== "ready") return yield* rejected();
					yield* assertTransferSentinel(app, selection, preparation, true);
				} else {
					yield* reserveTransferSentinel(app, credentials.principal, selection, preparation);
					if (appStore._tag === "file") {
						for (const name of [appStore.filename, path.dirname(appStore.filename)])
							yield* Effect.scoped(fs.open(name).pipe(Effect.flatMap((file) => file.sync)));
					}
					if (preparation.sentinel === "pending") yield* markReady;
				}
				yield* receipt("ready");
				// Sentinel CREATE and INSERT have committed, and the durable preparing receipt is ready.
				yield* initializeBootSchema.pipe(Effect.provideService(SqlClient.SqlClient, boot));
				yield* boot.withTransaction(
					Effect.gen(function* () {
						yield* lockBootWrite(boot);
						const current = yield* read;
						const ledger =
							yield* boot`SELECT migration_id,name FROM boot_migrations ORDER BY migration_id DESC LIMIT 1`.pipe(
								decodeRows(Schema.Struct({ migration_id: Schema.Int, name: Schema.String })),
							);
						if (ledger[0]?.migration_id !== transferProtocol.id || ledger[0]?.name !== transferProtocol.name)
							return yield* rejected();
						if (!current)
							yield* boot`INSERT INTO settings(${boot("key")},value) VALUES ('transfer_state','in_progress'),('transfer_prepare',${selectionText(selection)})`;
					}),
				);
			});
	});
