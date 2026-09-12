import type { TransferColumn, TransferInventory, TransferTable } from "@comms/storage/transfer-inventory";
import type { TransferKind } from "@comms/storage/transfer-values";
import { Effect, Schema } from "effect";
import {
	coreSearchObjects,
	derivedExpression,
	sqliteEventsDefinition,
	syntheticKey,
	type TransferEngine,
	type TransferStore,
} from "./derived-schema.ts";

export class TransferPlanError extends Schema.TaggedError<TransferPlanError>()("TransferPlanError", {
	code: Schema.Literals(["transfer_schema_mismatch", "transfer_schema_unsupported"]),
	object: Schema.String,
}) {}
const mismatch = (object: string) => new TransferPlanError({ code: "transfer_schema_mismatch", object });
const unsupported = (object: string) => new TransferPlanError({ code: "transfer_schema_unsupported", object });
const same = (left: readonly string[], right: readonly string[]) =>
	left.length === right.length && left.every((value, index) => value === right[index]);
const normalized = (expression: string) => expression.trim().replace(/\s+/g, " ");
const generatedNames = [
	"id_hash",
	"key_hash",
	"path_hash",
	"type",
	"actor",
	"instance",
	"level",
	"publishing_guard",
	"active_guard",
	"body_tsv",
	"previous_body_tsv",
	"previous_body",
] as const;

const logicalTable = (store: TransferStore, engine: TransferEngine, table: TransferTable) =>
	Effect.gen(function* () {
		const synthetic = syntheticKey(store, table.name);
		const columns: TransferColumn[] = [];
		const expectedGenerated = generatedNames.filter(
			(column) => derivedExpression(store, engine, table.name, column) !== undefined,
		);
		if (
			engine !== "sqlite" &&
			expectedGenerated.some((name) => !table.columns.some((column) => column.name === name && column.generated))
		)
			return yield* mismatch(table.name);
		for (const column of table.columns) {
			const object = `${table.name}.${column.name}`;
			if (column.generated) {
				if (engine === "sqlite") {
					if (
						store !== "boot" ||
						table.name !== "events" ||
						!["type", "actor", "instance", "level"].includes(column.name) ||
						table.definition !== sqliteEventsDefinition
					)
						return yield* unsupported(object);
				} else {
					const expected = derivedExpression(store, engine, table.name, column.name);
					if (
						!expected ||
						typeof column.expression !== "string" ||
						normalized(column.expression) !== normalized(expected)
					)
						return yield* unsupported(object);
				}
				continue;
			}
			if (engine !== "sqlite" && synthetic && column.name === "row_id") {
				if (!column.identity || column.kind !== "integer" || !same(table.primaryKey, ["row_id"]))
					return yield* unsupported(object);
				continue;
			}
			if (column.kind === "unsupported") return yield* unsupported(object);
			columns.push(column);
		}
		if (
			engine !== "sqlite" &&
			synthetic &&
			!table.columns.some((column) => column.name === "row_id" && column.identity)
		)
			return yield* mismatch(table.name);
		const key = synthetic ?? table.primaryKey;
		if (!key.length || !key.every((name) => columns.some((column) => column.name === name)))
			return yield* unsupported(table.name);
		if (
			key.some(
				(name) =>
					!["integer", "text", "bytes"].includes(columns.find((column) => column.name === name)?.kind ?? "unsupported"),
			)
		)
			return yield* unsupported(`${table.name}.key`);
		if (synthetic && engine === "sqlite" && !same(table.primaryKey, synthetic)) return yield* mismatch(table.name);
		if (new Set(columns.map((column) => column.name)).size !== columns.length) return yield* mismatch(table.name);
		return { table, columns, key };
	});

const ledgerNames = (store: TransferStore): readonly string[] =>
	store === "boot" ? ["boot_migrations"] : ["core_migrations", "migrations", "extension_migrations"];
const ledgerPlan = (table: TransferTable) =>
	Effect.gen(function* () {
		const extension = table.name === "extension_migrations";
		const names = extension ? ["extension", "name", "checksum"] : ["migration_id", "name", "created_at"];
		const key = extension ? ["extension", "name"] : ["migration_id"];
		if (
			!same(table.columns.map((column) => column.name).sort(), [...names].sort()) ||
			!same(table.primaryKey, key) ||
			table.foreignKeys.length
		)
			return yield* mismatch(table.name);
		const columns: Array<{ name: string; kind: TransferKind; nullable: boolean }> = [];
		for (const column of table.columns) {
			if (column.generated || (column.identity && column.name !== "migration_id"))
				return yield* unsupported(`${table.name}.${column.name}`);
			if (column.name === "created_at") {
				if (
					!["datetime", "timestamp", "timestamp without time zone", "timestamp with time zone"].includes(
						column.type.toLowerCase(),
					)
				)
					return yield* mismatch(`${table.name}.created_at`);
				continue;
			}
			const integer = column.name === "migration_id";
			if (integer ? !["integer", "int", "bigint"].includes(column.type.toLowerCase()) : column.kind !== "text")
				return yield* mismatch(`${table.name}.${column.name}`);
			columns.push({ name: column.name, kind: integer ? "integer" : "text", nullable: false });
		}
		return {
			name: table.name,
			columns: columns.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
			key,
			identities: [],
		};
	});

/** Read-only policy over exhaustive inventories. Ledgers are separated explicitly for comparison, never data copy. Target migrations must already have succeeded.
 * No unsupported generated column, arbitrary JSON conversion or prefix-based exclusion is inferred. */
export const logicalTransferPlan = (options: {
	readonly store: TransferStore;
	readonly source: { readonly engine: TransferEngine; readonly inventory: TransferInventory };
	readonly target: { readonly engine: TransferEngine; readonly inventory: TransferInventory };
}) =>
	Effect.gen(function* () {
		const { store, source, target } = options;
		for (const side of [source, target]) {
			const expected =
				store === "app" && side.engine === "sqlite" ? coreSearchObjects.map((object) => object.name).sort() : [];
			const internal =
				side.engine === "sqlite" ? ["sqlite_schema", "sqlite_sequence", "sqlite_stat1", "sqlite_stat4"] : [];
			const shadows =
				store === "app" && side.engine === "sqlite"
					? [
							"messages_fts_data",
							"messages_fts_idx",
							"messages_fts_content",
							"messages_fts_docsize",
							"messages_fts_config",
						]
					: [];
			const allowed = [...expected, ...internal, ...shadows];
			if (
				new Set(side.inventory.derived).size !== side.inventory.derived.length ||
				expected.some((name) => !side.inventory.derived.includes(name)) ||
				side.inventory.derived.some((name) => !allowed.includes(name))
			)
				return yield* mismatch("derived");
		}
		const names = source.inventory.tables.map((table) => table.name).sort();
		if (new Set(names).size !== names.length || !same(names, target.inventory.tables.map((table) => table.name).sort()))
			return yield* mismatch("tables");
		const plans: Array<{
			name: string;
			columns: Array<{ name: string; kind: TransferKind; nullable: boolean }>;
			key: readonly string[];
			identities: string[];
		}> = [];
		const dependencies = new Map<string, readonly string[]>();
		const ledgers: Array<Effect.Success<ReturnType<typeof ledgerPlan>>> = [];
		for (const name of names) {
			const sourceTable = source.inventory.tables.find((table) => table.name === name);
			const targetTable = target.inventory.tables.find((table) => table.name === name);
			if (!sourceTable || !targetTable) return yield* mismatch(name);
			if (ledgerNames(store).includes(name)) {
				const from = yield* ledgerPlan(sourceTable);
				const to = yield* ledgerPlan(targetTable);
				if (
					!same(
						from.columns.map((column) => column.name),
						to.columns.map((column) => column.name),
					)
				)
					return yield* mismatch(name);
				ledgers.push(to);
				continue;
			}
			const from = yield* logicalTable(store, source.engine, sourceTable);
			const to = yield* logicalTable(store, target.engine, targetTable);
			if (
				!same(from.columns.map((column) => column.name).sort(), to.columns.map((column) => column.name).sort()) ||
				!same(from.key, to.key)
			)
				return yield* mismatch(name);
			const columns: Array<{ name: string; kind: TransferKind; nullable: boolean }> = [];
			for (const column of [...from.columns].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
				const destination = to.columns.find((entry) => entry.name === column.name);
				if (
					!destination ||
					destination.kind === "unsupported" ||
					column.kind === "unsupported" ||
					destination.kind !== column.kind
				)
					return yield* mismatch(`${name}.${column.name}`);
				columns.push({ name: column.name, kind: column.kind, nullable: destination.nullable });
			}
			const foreign = (table: TransferTable) =>
				table.foreignKeys.map((key) => JSON.stringify([key.columns, key.table, key.targets])).sort();
			if (!same(foreign(sourceTable), foreign(targetTable))) return yield* mismatch(`${name}.foreign_keys`);
			for (const constraint of sourceTable.foreignKeys) {
				const referenced = source.inventory.tables.find((table) => table.name === constraint.table);
				if (!referenced || !constraint.columns.every((column) => columns.some((entry) => entry.name === column)))
					return yield* unsupported(`${name}.foreign_keys`);
				const targetLogical = yield* ledgerNames(store).includes(referenced.name)
					? ledgerPlan(referenced)
					: logicalTable(store, source.engine, referenced);
				if (!constraint.targets.every((column) => targetLogical.columns.some((entry) => entry.name === column)))
					return yield* unsupported(`${name}.foreign_keys`);
			}
			dependencies.set(
				name,
				sourceTable.foreignKeys.map((key) => key.table),
			);
			plans.push({
				name,
				columns,
				key: from.key,
				identities: to.columns.filter((column) => column.identity).map((column) => column.name),
			});
		}
		const ordered: typeof plans = [];
		// Allocator first, then FK parents. Never disable constraints to make an unsupported cycle appear safe.
		const pending = [...plans].sort((a, b) => (a.name === "seq" ? -1 : b.name === "seq" ? 1 : 0));
		while (pending.length) {
			const index = pending.findIndex((plan) =>
				(dependencies.get(plan.name) ?? []).every(
					(name) => ordered.some((prior) => prior.name === name) || ledgers.some((ledger) => ledger.name === name),
				),
			);
			if (index < 0) return yield* unsupported("foreign_key_cycle");
			const plan = pending[index];
			if (!plan) return yield* mismatch("tables");
			if (store === "boot" && ordered.length === 0 && names.includes("seq") && plan.name !== "seq")
				return yield* unsupported("seq.dependencies");
			ordered.push(plan);
			pending.splice(index, 1);
		}
		return { tables: ordered, ledgers };
	});
