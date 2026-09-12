import type { TransferInventory, TransferTable } from "@comms/storage/transfer-inventory";
import type { TransferEngine, TransferStore } from "./derived-schema.ts";

/** These MySQL journals track nontransactional DDL. They are prerequisites to prove empty,
 * never transferred data. The coordinator checks both sides before copying and at final verification. */
export const emptyJournalNames = (store: TransferStore, engine: TransferEngine): readonly string[] =>
	engine !== "mysql"
		? []
		: store === "boot"
			? ["boot_migrations_intent"]
			: ["core_migrations_intent", "kernel_migration_intent"];

export const emptyJournalPlan = (table: TransferTable) => {
	const kernel = table.name === "kernel_migration_intent";
	const shape = kernel
		? [
				{ name: "singleton", type: "int", nullable: false },
				{ name: "scope", type: "varchar", length: 255, nullable: false },
				{ name: "name", type: "varchar", length: 255, nullable: false },
				{ name: "epoch", type: "varchar", length: 128, nullable: false },
			]
		: [
				{ name: "singleton", type: "int", nullable: false },
				{ name: "migration_id", type: "int", nullable: false },
				{ name: "name", type: "varchar", length: 255, nullable: false },
				{ name: "operation", type: "int", nullable: false },
				{ name: "active", type: "varchar", length: 255, nullable: true },
			];
	if (
		table.primaryKey.length !== 1 ||
		table.primaryKey[0] !== "singleton" ||
		table.foreignKeys.length ||
		table.columns.length !== shape.length
	)
		return undefined;
	for (const expected of shape) {
		const actual = table.columns.find((column) => column.name === expected.name);
		if (
			!actual ||
			actual.type !== expected.type ||
			actual.nullable !== expected.nullable ||
			actual.generated ||
			actual.identity ||
			actual.default != null ||
			actual.length !== expected.length ||
			actual.kind !== (expected.type === "int" ? "integer" : "text")
		)
			return undefined;
	}
	return {
		name: table.name,
		columns: table.columns.map((column) => ({
			name: column.name,
			kind: column.type === "int" ? ("integer" as const) : ("text" as const),
			nullable: column.nullable,
		})),
		key: ["singleton"],
		identities: [],
	};
};

export const withoutEmptyJournals = (inventory: TransferInventory, names: readonly string[]): TransferInventory => ({
	...inventory,
	tables: inventory.tables.filter((table) => !names.includes(table.name)),
});
