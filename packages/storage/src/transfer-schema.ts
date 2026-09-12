import { Schema } from "effect";
import type { TransferKind } from "./transfer-values.ts";
import type { ColumnShape } from "./schema-shape.ts";

export class TransferInventoryError extends Schema.TaggedError<TransferInventoryError>()("TransferInventoryError", {
	code: Schema.Literals(["transfer_object_unsupported", "transfer_catalog_invalid"]),
	object: Schema.String,
}) {}
export interface TransferColumn extends ColumnShape {
	readonly declaration: string;
	readonly kind: TransferKind | "unsupported";
	readonly generated: boolean;
	readonly identity: boolean;
}
export interface TransferForeignKey {
	readonly name: string;
	readonly columns: ReadonlyArray<string>;
	readonly table: string;
	readonly targets: ReadonlyArray<string>;
	readonly onUpdate: string;
	readonly onDelete: string;
}
export interface TransferTable {
	/** Original SQLite CREATE TABLE text for trusted generated-expression validation. */
	readonly definition?: string;
	readonly name: string;
	readonly columns: ReadonlyArray<TransferColumn>;
	readonly primaryKey: ReadonlyArray<string>;
	readonly foreignKeys: ReadonlyArray<TransferForeignKey>;
}
/** Supplied from trusted migrations, never inferred from the source database being transferred. */
export interface TransferDerivedObject {
	readonly name: string;
	readonly kind: "table" | "trigger";
	readonly definition: string;
}
export interface TransferInventory {
	readonly tables: ReadonlyArray<TransferTable>;
	readonly derived: ReadonlyArray<string>;
}

/** Trusted semantic JSON columns from reviewed migrations, not inferred from row contents. */
export interface TransferJsonColumn {
	readonly table: string;
	readonly column: string;
}
