import { postgresSearchDeclarations } from "../../src/transfer/search-capability.ts";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Context, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { transferInventory, TransferInventoryError, type TransferInventory } from "@comms/storage/transfer-inventory";
import { guardianClientLayer } from "@comms/storage/remote-client";
import { remoteAppKernelOperations } from "../../../boot/src/app-kernel-schema.ts";
import { validateExtensionLedger } from "../../src/transfer/extension-ledger.ts";
import { initializeTransferApp } from "../../src/kernel/transfer-app-initialize.ts";
import { coreJsonColumns, coreSearchObjects, type TransferEngine } from "../../src/transfer/derived-schema.ts";
import { logicalTransferPlan, TransferPlanError } from "../../src/transfer/logical-plan.ts";
import { Reactivity } from "effect/unstable/reactivity";

interface Catalog {
	readonly engine: TransferEngine;
	readonly sql: SqlClient;
	readonly inventory: TransferInventory;
	readonly ledgers: Effect.Success<ReturnType<typeof initializeTransferApp>>;
}
const settings = Schema.fromJsonString(
	Schema.Struct({
		engine: Schema.Literals(["pg", "mysql"]),
		host: Schema.String,
		port: Schema.Int,
		database: Schema.String,
		username: Schema.String,
		password: Schema.String,
	}),
);

async function main() {
	let stage = "configuration";
	let detail = "failure";
	try {
		const pg = Schema.decodeSync(settings)(await readFile(process.env.COMMS_TRANSFER_APP_SIX_PG ?? "", "utf8"));
		const mysql = Schema.decodeSync(settings)(await readFile(process.env.COMMS_TRANSFER_APP_SIX_MYSQL ?? "", "utf8"));
		assert.equal(pg.engine, "pg");
		assert.equal(mysql.engine, "mysql");
		assert.equal(pg.database, "comms_transfer_app_six");
		assert.equal(mysql.database, "comms_transfer_app_six");
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const frozenSource = yield* fs.realPath(path.resolve(import.meta.dirname, "../../src"));
				const epoch = "c".repeat(64);
				const catalogs: Catalog[] = [];
				for (const engine of ["sqlite", "pg", "mysql"] as const) {
					stage = `${engine}:initialize`;
					const config = engine === "pg" ? pg : mysql;
					const sql: SqlClient =
						engine === "sqlite"
							? yield* SqliteClient.make({ filename: ":memory:" })
							: Context.get(
									yield* Layer.build(
										guardianClientLayer({
											connection: { ...config, password: Redacted.make(config.password), tls: false },
											attempt: epoch,
											register: () => Effect.void,
										}),
									),
									SqlClient,
								);
					if (engine === "sqlite") {
						// Boot-owned kernel DDL from transfer-kernel-initialize; the frozen editable source
						// below performs every core/editable/extension migration, without HTTP/lifecycle work.
						yield* sql`CREATE TABLE kernel_writer (singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL)`;
						yield* sql`CREATE TABLE mutation_batches (id TEXT PRIMARY KEY,from_seq INTEGER NOT NULL,to_seq INTEGER NOT NULL,count INTEGER NOT NULL)`;
						yield* sql`CREATE TABLE outbox (seq INTEGER PRIMARY KEY,transaction_id TEXT NOT NULL,event TEXT NOT NULL,shipped_at INTEGER)`;
						yield* sql`CREATE TABLE store_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id TEXT NOT NULL,initialized_at INTEGER NOT NULL,transferred_to TEXT)`;
					} else
						for (const operation of remoteAppKernelOperations(sql, config.username)) {
							// A single disposable schema owner deliberately does not claim credential isolation.
							if (operation.name.startsWith("grant:")) continue;
							if (!(yield* operation.postcondition)) yield* operation.run;
							assert(yield* operation.postcondition);
						}
					if (!(yield* sql`SELECT singleton FROM kernel_writer`).length)
						yield* sql`INSERT INTO kernel_writer VALUES(1,${epoch})`;
					if (!(yield* sql`SELECT singleton FROM store_identity`).length)
						yield* sql`INSERT INTO store_identity VALUES(1,'12345678-1234-4123-8123-123456789abc',1,NULL)`;
					const ledgers = yield* initializeTransferApp(sql, epoch, frozenSource);
					assert.equal(ledgers.core.length, 12);
					assert.equal(ledgers.core.at(-1)?.name, "search_diacritics");
					assert(ledgers.extensions.length > 0);
					stage = `${engine}:inventory`;
					const inventory = yield* sql.withTransaction(
						transferInventory(
							sql,
							engine === "sqlite" ? coreSearchObjects : engine === "pg" ? yield* postgresSearchDeclarations(sql) : [],
							coreJsonColumns,
						),
					);
					if (engine === "mysql") {
						stage = "mysql:altered-subscription-hash";
						for (const name of ["instance_hash", "idempotency_hash"]) {
							const changed: { readonly engine: "mysql"; readonly inventory: TransferInventory } = {
								engine,
								inventory: {
									...inventory,
									tables: inventory.tables.map((table) =>
										table.name === "webhook_subscriptions"
											? {
													...table,
													columns: table.columns.map((column) =>
														column.name === name ? { ...column, expression: "unhex(sha2(`agent`,256))" } : column,
													),
												}
											: table,
									),
								},
							};
							const refused = yield* logicalTransferPlan({ store: "app", source: changed, target: changed }).pipe(
								Effect.result,
							);
							assert.equal(refused._tag, "Failure");
						}
					}
					catalogs.push({ engine, sql, inventory, ledgers });
				}
				const pairs: string[] = [];
				const verifiedProofs: { from: TransferEngine; to: TransferEngine; count: number }[] = [];
				for (const source of catalogs)
					for (const target of catalogs) {
						if (source.engine === target.engine) continue;
						stage = `${source.engine}->${target.engine}:plan`;
						const plan = yield* logicalTransferPlan({ store: "app", source, target });
						assert.deepEqual(plan.ledgers.map((table) => table.name).sort(), [
							"core_migrations",
							"extension_migrations",
							"migrations",
						]);
						assert.equal(
							plan.tables.length + plan.ledgers.length + plan.empty.source.length,
							source.inventory.tables.length,
						);
						assert.equal(
							plan.tables.length + plan.ledgers.length + plan.empty.target.length,
							target.inventory.tables.length,
						);
						assert.deepEqual(plan.tables.find((table) => table.name === "idempotency")?.key, ["instance", "key"]);
						for (const column of coreJsonColumns)
							assert.equal(
								plan.tables
									.find((table) => table.name === column.table)
									?.columns.find((entry) => entry.name === column.column)?.kind,
								"json",
							);
						stage = `${source.engine}->${target.engine}:empty-intents`;
						for (const [side, catalog] of [
							["source", source],
							["target", target],
						] as const) {
							assert.deepEqual(
								plan.empty[side].map((table) => table.name).sort(),
								catalog.engine === "mysql" ? ["core_migrations_intent", "kernel_migration_intent"] : [],
							);
							for (const table of plan.empty[side])
								assert.equal((yield* catalog.sql`SELECT 1 FROM ${catalog.sql(table.name)} LIMIT 1`).length, 0);
						}
						stage = `${source.engine}->${target.engine}:ledgers`;
						assert.deepEqual(source.ledgers.core, target.ledgers.core);
						assert.deepEqual(source.ledgers.editable, target.ledgers.editable);
						assert.deepEqual(
							source.ledgers.extensions.map(({ extension, name }) => ({ extension, name })),
							target.ledgers.extensions.map(({ extension, name }) => ({ extension, name })),
						);
						// Replay only the target factories; source SQL is read from their explicit
						// dialect declaration, never executed against the source for inspection.
						const replay = yield* initializeTransferApp(target.sql, epoch, frozenSource, source.engine);
						assert.deepEqual(replay.extensions, target.ledgers.extensions);
						assert.deepEqual(
							replay.extensionProofs.map(({ extension, name, sourceChecksum }) => ({
								extension,
								name,
								checksum: sourceChecksum,
							})),
							source.ledgers.extensions,
						);
						assert.deepEqual(
							replay.extensionProofs.map(({ extension, name, targetChecksum }) => ({
								extension,
								name,
								checksum: targetChecksum,
							})),
							target.ledgers.extensions,
						);
						yield* validateExtensionLedger(
							source.ledgers.extensions,
							target.ledgers.extensions,
							replay.extensionProofs,
						);
						const alteredSource = source.ledgers.extensions.map((row, index) =>
							index === 0 ? { ...row, checksum: "0".repeat(64) } : row,
						);
						for (const invalid of [
							validateExtensionLedger(alteredSource, target.ledgers.extensions, replay.extensionProofs),
							validateExtensionLedger(
								source.ledgers.extensions,
								target.ledgers.extensions,
								replay.extensionProofs.slice(1),
							),
						]) {
							const refusal = yield* invalid.pipe(Effect.result);
							assert.equal(refusal._tag, "Failure");
							if (refusal._tag === "Failure") assert.equal(refusal.failure.code, "transfer_extension_ledger_invalid");
						}
						verifiedProofs.push({ from: source.engine, to: target.engine, count: replay.extensionProofs.length });
						pairs.push(`${source.engine}->${target.engine}`);
					}
				return { pairs, verifiedProofs };
			}).pipe(
				Effect.tapError((error) =>
					Effect.sync(() => {
						if (Schema.is(TransferPlanError)(error) || Schema.is(TransferInventoryError)(error))
							detail = `${error.code}:${error.object}`;
					}),
				),
				Effect.scoped,
				Effect.provide(Reactivity.layer),
				Effect.provide(BunServices.layer),
			),
		);
		process.stdout.write(JSON.stringify(result));
	} catch {
		throw new Error(`App catalog ${stage}:${detail}; driver details suppressed`);
	}
}
await main();
