import { postgresSearchDeclarations } from "../../src/transfer/search-capability.ts";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { clientLayer } from "@comms/storage/client";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { transferInventory, TransferInventoryError } from "@comms/storage/transfer-inventory";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { remoteAppKernelOperations } from "../../../boot/src/app-kernel-schema.ts";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
import { initializeRemoteCore } from "../../src/ext/core/core-schema-remote.ts";
import { coreJsonColumns, bootDerivedObjects } from "../../src/transfer/derived-schema.ts";
import { logicalTransferPlan, TransferPlanError } from "../../src/transfer/logical-plan.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const bootPath = process.argv[2];
const appPath = process.argv[3];
const sqlitePath = process.argv[4];
const selectedStore = process.argv[5];
if (selectedStore !== "boot" && selectedStore !== "app") throw Error("Missing catalog store role");
if (!bootPath || !appPath || !sqlitePath) throw Error("Missing disposable catalog configurations");
const boot = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(bootPath, "utf8"));
const app = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(appPath, "utf8"));
if (
	boot.engine !== app.engine ||
	boot.database !== "comms_transfer_catalog_boot" ||
	app.database !== "comms_transfer_catalog_app"
)
	throw Error("Dedicated catalog database pair required");

// These isolated schema fixtures deliberately use one scoped owner and do not claim to test role isolation.
// Every table comes from real initialization operations; production grant steps have separate native acceptance.
for (const [store, settings] of [
	["boot", boot],
	["app", app],
] as const) {
	if (store !== selectedStore) continue;
	let stage = "initialize";
	const options = {
		connection: { ...settings, password: Redacted.make(settings.password), tls: false },
		attempt: "ca".repeat(32),
	};
	const layer = remoteClientLayer({ ...options, register: () => Effect.void }).pipe(
		Layer.provide(remoteInspectorLayer(options)),
	);
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			if (store === "boot") {
				yield* initializeBootSchema;
				assert.equal((yield* sql`SELECT migration_id FROM boot_migrations`).length, 20);
			} else {
				for (const operation of remoteAppKernelOperations(sql, settings.username)) {
					if (operation.name.startsWith("grant:")) continue;
					if (!(yield* operation.postcondition)) yield* operation.run;
					assert(yield* operation.postcondition);
				}
				if (!(yield* sql`SELECT singleton FROM kernel_writer`).length)
					yield* sql`INSERT INTO kernel_writer(singleton,epoch) VALUES (1,'catalog')`;
				yield* initializeRemoteKernelSchema(sql, "catalog");
				yield* initializeRemoteCore(sql, "catalog");
				assert.equal((yield* sql`SELECT migration_id FROM core_migrations`).length, 12);
			}
			stage = "inventory";
			const inventory = yield* sql.withTransaction(
				transferInventory(
					sql,
					settings.engine === "pg" && store === "app" ? yield* postgresSearchDeclarations(sql) : [],
					store === "app" ? coreJsonColumns : [],
				),
			);
			for (const name of store === "boot"
				? ["boot_migrations", "settings", "seq", "events", "backups", "source_batches", "versions"]
				: [
						"kernel_writer",
						"outbox",
						"store_identity",
						"mutation_batches",
						"messages",
						"topics",
						"reads",
						"kv",
						"idempotency",
						"topic_page_continuations",
						"core_migrations",
						"extension_migrations",
						"migrations",
						"protected_sql_tables",
					])
				assert(
					inventory.tables.some((table) => table.name === name),
					`Missing initialized table ${name}`,
				);
			stage = "projection";
			const plan = yield* logicalTransferPlan({
				store,
				source: { engine: settings.engine, inventory },
				target: { engine: settings.engine, inventory },
			});
			assert.equal(plan.tables.length + plan.ledgers.length + plan.empty.source.length, inventory.tables.length);
			for (const table of plan.empty.source)
				assert.equal((yield* sql`SELECT singleton FROM ${sql(table.name)}`).length, 0);
			assert.deepEqual(
				plan.ledgers.map((table) => table.name).sort(),
				store === "boot" ? ["boot_migrations"] : ["core_migrations", "extension_migrations", "migrations"],
			);
			if (store === "boot") {
				assert.equal(plan.tables[0]?.name, "seq");
				stage = "sqlite-cross-projection";
				const sqlite = yield* Effect.gen(function* () {
					const local = yield* SqlClient.SqlClient;
					yield* initializeBootSchema;
					return {
						inventory: yield* transferInventory(local, bootDerivedObjects),
						ledger: yield* local`SELECT migration_id,name FROM boot_migrations ORDER BY migration_id`,
					};
				}).pipe(Effect.provide(clientLayer({ _tag: "file", filename: sqlitePath })));
				assert.deepEqual(
					yield* sql`SELECT migration_id,name FROM boot_migrations ORDER BY migration_id`,
					sqlite.ledger,
				);
				for (const [source, target] of [
					[
						{ engine: settings.engine, inventory },
						{ engine: "sqlite", inventory: sqlite.inventory },
					],
					[
						{ engine: "sqlite", inventory: sqlite.inventory },
						{ engine: settings.engine, inventory },
					],
				] as const) {
					const cross: Effect.Success<ReturnType<typeof logicalTransferPlan>> = yield* logicalTransferPlan({
						store,
						source,
						target,
					});
					assert.deepEqual(
						cross.tables.map((table) => table.name),
						plan.tables.map((table) => table.name),
					);
				}
				assert.deepEqual(
					plan.tables.find((table) => table.name === "events")?.columns.map((column) => column.name),
					["event", "seq", "topic", "transaction_id"],
				);
			} else {
				assert.deepEqual(plan.tables.find((table) => table.name === "idempotency")?.key, ["instance", "key"]);
				for (const selected of coreJsonColumns)
					assert.equal(
						plan.tables
							.find((table) => table.name === selected.table)
							?.columns.find((column) => column.name === selected.column)?.kind,
						"json",
					);
				assert(
					!plan.tables
						.find((table) => table.name === "messages")
						?.columns.some((column) => ["body_tsv", "previous_body_tsv", "previous_body"].includes(column.name)),
				);
			}
			process.stdout.write(`CATALOG_VERIFIED ${settings.engine} ${store}\n`);
		}).pipe(
			Effect.catch((error) =>
				Effect.fail(
					new Error(
						Schema.is(TransferPlanError)(error) || Schema.is(TransferInventoryError)(error)
							? `${store}:${stage}:${error.code}:${error.object}`
							: `${store}:${stage}:initialization_failed`,
					),
				),
			),
			Effect.scoped,
			Effect.provide(layer),
		),
	);
}
