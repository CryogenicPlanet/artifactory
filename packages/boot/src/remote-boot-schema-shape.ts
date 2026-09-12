import { tableShape, type ColumnShape } from "@comms/storage/remote-migrations";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

/** Every boot text value is case-sensitive; absent defaults must remain absent after DDL recovery. */
export const bootTableShape = (
	sql: SqlClient,
	engine: "pg" | "mysql",
	table: string,
	columns: readonly ColumnShape[],
	primaryKey: readonly string[],
	options: Parameters<typeof tableShape>[4],
) =>
	tableShape(
		sql,
		table,
		columns.map((column) => ({
			...column,
			default: column.default ?? null,
			expression: column.expression ?? (engine === "pg" ? null : ""),
			collation:
				engine === "mysql" && (column.type === "varchar" || column.type === "longtext") ? "utf8mb4_0900_bin" : null,
		})),
		primaryKey,
		options,
	);
