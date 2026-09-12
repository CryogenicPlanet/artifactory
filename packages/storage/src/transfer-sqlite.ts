import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import {
	TransferInventoryError,
	type TransferDerivedObject,
	type TransferColumn,
	type TransferInventory,
	type TransferTable,
} from "./transfer-schema.ts";

const objectsSchema = Schema.Array(
	Schema.Struct({ type: Schema.String, name: Schema.String, sql: Schema.NullOr(Schema.String) }),
);
const tablesSchema = Schema.Array(
	Schema.Struct({ schema: Schema.String, name: Schema.String, type: Schema.String, wr: Schema.Int }),
);
const columnsSchema = Schema.Array(
	Schema.Struct({
		name: Schema.String,
		type: Schema.String,
		notnull: Schema.Int,
		pk: Schema.Int,
		hidden: Schema.Int,
		dflt_value: Schema.NullOr(Schema.String),
	}),
);
const foreignSchema = Schema.Array(
	Schema.Struct({
		id: Schema.Int,
		seq: Schema.Int,
		table: Schema.String,
		from: Schema.String,
		to: Schema.NullOr(Schema.String),
		on_update: Schema.String,
		on_delete: Schema.String,
		match: Schema.String,
	}),
);
const unsupported = (object: string) => new TransferInventoryError({ code: "transfer_object_unsupported", object });
const invalid = (object: string) => new TransferInventoryError({ code: "transfer_catalog_invalid", object });

/** SQLite's catalog marks virtual-table shadows; ordinary tables are never excluded by prefix. */
export const sqliteTransferInventory = (
	sql: SqlClient,
	derived: ReadonlyArray<TransferDerivedObject>,
): Effect.Effect<TransferInventory, unknown> =>
	Effect.gen(function* () {
		const objects = yield* sql`SELECT type,name,sql FROM main.sqlite_schema ORDER BY name`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(objectsSchema)),
		);
		const tables = yield* sql`PRAGMA main.table_list`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(tablesSchema)));
		const excluded: string[] = [];
		for (const declaration of derived) {
			const object = objects.find((row) => row.name === declaration.name && row.type === declaration.kind);
			if (!object || object.sql !== declaration.definition || excluded.includes(declaration.name))
				return yield* invalid(declaration.name);
			if (
				declaration.kind === "table" &&
				!/^CREATE VIRTUAL TABLE\b[\s\S]*\bUSING fts5\s*\(/i.test(declaration.definition)
			)
				return yield* unsupported(declaration.name);
			excluded.push(declaration.name);
		}
		for (const object of objects) {
			if (object.type === "trigger" || object.type === "view") {
				if (!excluded.includes(object.name)) return yield* unsupported(object.name);
			}
		}
		for (const object of objects) {
			if (object.type !== "index") continue;
			const expressions =
				yield* sql`SELECT cid FROM pragma_index_xinfo(${object.name},'main') WHERE key=1 AND cid=-2`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ cid: Schema.Int })))),
				);
			if (expressions.length > 0) return yield* unsupported(object.name);
		}
		const result: TransferTable[] = [];
		const foreign: Array<{ readonly table: string; readonly rows: typeof foreignSchema.Type }> = [];
		for (const table of tables) {
			if (table.schema === "temp" && table.name === "sqlite_temp_schema") continue;
			if (table.schema !== "main") return yield* unsupported(`${table.schema}.${table.name}`);
			if (["sqlite_schema", "sqlite_sequence", "sqlite_stat1", "sqlite_stat4"].includes(table.name)) {
				excluded.push(table.name);
				continue;
			}
			if (table.type === "shadow") {
				if (!derived.some((item) => item.kind === "table" && table.name.startsWith(`${item.name}_`)))
					return yield* unsupported(table.name);
				excluded.push(table.name);
				continue;
			}
			if (excluded.includes(table.name)) continue;
			if (table.type !== "table") return yield* unsupported(table.name);
			const columns =
				yield* sql`SELECT name,type,"notnull",pk,hidden,dflt_value FROM pragma_table_xinfo(${table.name},'main') ORDER BY cid`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(columnsSchema)),
				);
			if (columns.length === 0) return yield* invalid(table.name);
			const keys = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
			const indexes = yield* sql`SELECT origin FROM pragma_index_list(${table.name},'main')`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ origin: Schema.String })))),
			);
			const described: TransferColumn[] = [];
			for (const column of columns) {
				const type = column.type.toUpperCase().trim();
				const kind = /^(INT|INTEGER|TINYINT|SMALLINT|MEDIUMINT|BIGINT|INT2|INT8)$/.test(type)
					? "integer"
					: /^(REAL|DOUBLE|DOUBLE PRECISION|FLOAT)$/.test(type)
						? "real"
						: /^(TEXT|CLOB|VARCHAR(?:\(\d+\))?|CHAR(?:\(\d+\))?)$/.test(type)
							? "text"
							: type === "BLOB"
								? "bytes"
								: "unsupported";
				if (![0, 2, 3].includes(column.hidden)) return yield* invalid(`${table.name}.${column.name}`);
				described.push({
					name: column.name,
					type: column.type,
					declaration: column.type,
					default: column.dflt_value,
					kind,
					nullable:
						column.notnull === 0 &&
						!(
							table.wr === 0 &&
							keys.length === 1 &&
							column.pk === 1 &&
							type === "INTEGER" &&
							!indexes.some((index) => index.origin === "pk")
						),
					generated: column.hidden !== 0,
					identity:
						table.wr === 0 &&
						keys.length === 1 &&
						column.pk === 1 &&
						type === "INTEGER" &&
						!indexes.some((index) => index.origin === "pk"),
				});
			}
			result.push({
				name: table.name,
				definition: objects.find((object) => object.type === "table" && object.name === table.name)?.sql ?? "",
				columns: described,
				primaryKey: keys.map((column) => column.name),
				foreignKeys: [],
			});
			foreign.push({
				table: table.name,
				rows: yield* sql`SELECT id,seq,"table","from","to",on_update,on_delete,match FROM pragma_foreign_key_list(${table.name},'main') ORDER BY id,seq`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(foreignSchema)),
				),
			});
		}
		const completed: TransferTable[] = [];
		for (const table of result) {
			const rows = foreign.find((entry) => entry.table === table.name)?.rows ?? [];
			// PRAGMA omits declared deferrability and SQLite ignores MATCH clauses. Refuse
			// such declarations conservatively, including ambiguous quoted/comment occurrences.
			if (rows.length && /\b(?:DEFERRABLE|MATCH)\b/i.test(table.definition ?? ""))
				return yield* unsupported(table.name);
			const keys = [];
			for (const id of new Set(rows.map((row) => row.id))) {
				const parts = rows.filter((row) => row.id === id);
				const first = parts[0];
				if (!first) return yield* invalid(table.name);
				if (
					first.match !== "NONE" ||
					!["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].includes(first.on_update) ||
					!["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].includes(first.on_delete)
				)
					return yield* unsupported(table.name);
				const target = result.find((entry) => entry.name === first.table);
				if (!target) return yield* unsupported(first.table);
				const targets: string[] = [];
				for (const part of parts) {
					const name = part.to ?? target.primaryKey[part.seq];
					if (!name || part.table !== first.table || !target.columns.some((column) => column.name === name))
						return yield* invalid(table.name);
					targets.push(name);
				}
				keys.push({
					name: String(id),
					columns: parts.map((part) => part.from),
					table: first.table,
					targets,
					onUpdate: first.on_update,
					onDelete: first.on_delete,
				});
			}
			completed.push({ ...table, foreignKeys: keys });
		}
		return {
			tables: completed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
			derived: excluded.sort(),
		};
	});
