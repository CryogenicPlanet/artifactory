import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "./dialect.ts";
export interface ColumnShape {
	readonly name: string;
	readonly type: string;
	readonly nullable: boolean;
	readonly length?: number;
	readonly expression?: string | null;
	readonly default?: string | null;
	readonly collation?: string | null;
}
export class SchemaShapeError extends Schema.TaggedError<SchemaShapeError>()("SchemaShapeError", {
	object: Schema.String,
}) {}
const columnRows = Schema.Array(
	Schema.Struct({
		name: Schema.String,
		type: Schema.String,
		nullable: Schema.String,
		length: Schema.NullOr(Schema.Finite),
		expression: Schema.NullOr(Schema.String),
		default: Schema.NullOr(Schema.String),
		collation: Schema.NullOr(Schema.String),
	}),
);
const indexRows = Schema.Array(
	Schema.Struct({
		name: Schema.String,
		unique: Schema.Finite,
		method: Schema.String,
		valid: Schema.Int,
		partial: Schema.Int,
		prefix: Schema.NullOr(Schema.Int),
	}),
);
/** Catalog checks never adopt unknown pre-existing objects; migration intent establishes ownership. */
export const tableShape = (
	sql: SqlClient,
	table: string,
	columns: ReadonlyArray<ColumnShape>,
	primaryKey: ReadonlyArray<string> = [],
	options: {
		readonly checks?: ReadonlyArray<string>;
		readonly foreignKeys?: ReadonlyArray<{ readonly column: string; readonly table: string; readonly target: string }>;
	} = {},
) =>
	Effect.gen(function* () {
		const tables = yield* on(sql, {
			sqlite: () => {
				throw new Error("Remote schema check requires PostgreSQL or MySQL");
			},
			pg: () =>
				sql`SELECT table_type AS kind,'InnoDB' AS engine FROM information_schema.tables WHERE table_schema='public' AND table_name=${table}`,
			mysql: () =>
				sql`SELECT TABLE_TYPE AS kind,ENGINE AS engine FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table}`,
		}).pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(Schema.Struct({ kind: Schema.String, engine: Schema.NullOr(Schema.String) })),
				),
			),
		);
		if (tables.length === 0) return false;
		if (tables.length !== 1 || tables[0]?.kind !== "BASE TABLE" || tables[0]?.engine !== "InnoDB")
			return yield* new SchemaShapeError({ object: table });
		const existing = yield* on(sql, {
			sqlite: () => {
				throw new Error("Remote schema check requires PostgreSQL or MySQL");
			},
			pg: () =>
				sql`SELECT column_name AS name,CASE WHEN data_type='USER-DEFINED' THEN udt_name ELSE data_type END AS type,is_nullable AS nullable,character_maximum_length AS length,generation_expression AS expression,column_default AS "default",collation_name AS collation FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} ORDER BY ordinal_position`,
			mysql: () =>
				sql`SELECT COLUMN_NAME AS name,DATA_TYPE AS type,IS_NULLABLE AS nullable,CHARACTER_MAXIMUM_LENGTH AS length,GENERATION_EXPRESSION AS expression,COLUMN_DEFAULT AS ${sql("default")},COLLATION_NAME AS collation FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} ORDER BY ORDINAL_POSITION`,
		}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(columnRows)));
		if (existing.length === 0) return false;
		if (
			existing.length !== columns.length ||
			columns.some((expected, index) => {
				const actual = existing[index];
				return (
					!actual ||
					actual.name !== expected.name ||
					actual.type !== expected.type ||
					(actual.nullable === "YES") !== expected.nullable ||
					(expected.length !== undefined && actual.length !== expected.length) ||
					(expected.expression !== undefined && actual.expression !== expected.expression) ||
					(expected.default !== undefined && actual.default !== expected.default) ||
					(expected.collation !== undefined && actual.collation !== expected.collation)
				);
			})
		)
			return yield* new SchemaShapeError({ object: table });
		const keys = yield* on(sql, {
			sqlite: () => {
				throw new Error("Remote schema check requires PostgreSQL or MySQL");
			},
			pg: () =>
				sql`SELECT k.column_name AS name FROM information_schema.table_constraints c JOIN information_schema.key_column_usage k ON k.constraint_schema=c.constraint_schema AND k.constraint_name=c.constraint_name AND k.table_name=c.table_name WHERE c.table_schema='public' AND c.table_name=${table} AND c.constraint_type='PRIMARY KEY' ORDER BY k.ordinal_position`,
			mysql: () =>
				sql`SELECT COLUMN_NAME AS name FROM information_schema.statistics WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX`,
		}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))));
		if (keys.length !== primaryKey.length || keys.some((key, index) => key.name !== primaryKey[index]))
			return yield* new SchemaShapeError({ object: table });

		if (options.checks) {
			const checks = yield* on(sql, {
				sqlite: () => {
					throw new Error("Remote schema check requires PostgreSQL or MySQL");
				},
				pg: () =>
					sql`SELECT pg_get_expr(c.conbin,c.conrelid) AS expression FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=${table} AND c.contype='c'`,
				mysql: () =>
					sql`SELECT c.CHECK_CLAUSE AS expression FROM information_schema.check_constraints c JOIN information_schema.table_constraints t ON t.CONSTRAINT_SCHEMA=c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME=c.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=${table} AND t.CONSTRAINT_TYPE='CHECK'`,
			}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ expression: Schema.String })))));
			const actual = checks.map((row) => row.expression).sort();
			const expected = [...options.checks].sort();
			if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index]))
				return yield* new SchemaShapeError({ object: table });
		}
		if (options.foreignKeys) {
			const foreign = yield* on(sql, {
				sqlite: () => {
					throw new Error("Remote schema check requires PostgreSQL or MySQL");
				},
				pg: () =>
					sql`SELECT k.column_name AS "column",f.table_name AS "table",f.column_name AS target FROM information_schema.table_constraints c JOIN information_schema.key_column_usage k ON k.constraint_schema=c.constraint_schema AND k.constraint_name=c.constraint_name JOIN information_schema.referential_constraints r ON r.constraint_schema=c.constraint_schema AND r.constraint_name=c.constraint_name JOIN information_schema.key_column_usage f ON f.constraint_schema=r.unique_constraint_schema AND f.constraint_name=r.unique_constraint_name AND f.ordinal_position=k.position_in_unique_constraint WHERE c.table_schema='public' AND c.table_name=${table} AND c.constraint_type='FOREIGN KEY' ORDER BY k.column_name`,
				mysql: () =>
					sql`SELECT COLUMN_NAME AS ${sql("column")},REFERENCED_TABLE_NAME AS ${sql("table")},REFERENCED_COLUMN_NAME AS target FROM information_schema.key_column_usage WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY COLUMN_NAME`,
			}).pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Array(Schema.Struct({ column: Schema.String, table: Schema.String, target: Schema.String })),
					),
				),
			);
			const expected = [...options.foreignKeys].sort((a, b) => a.column.localeCompare(b.column));
			if (
				foreign.length !== expected.length ||
				foreign.some(
					(row, index) =>
						row.column !== expected[index]?.column ||
						row.table !== expected[index]?.table ||
						row.target !== expected[index]?.target,
				)
			)
				return yield* new SchemaShapeError({ object: table });
		}
		return true;
	});
export const indexShape = (
	sql: SqlClient,
	table: string,
	index: string,
	columns: ReadonlyArray<string>,
	unique: boolean,
	method?: "gin" | "FULLTEXT",
) =>
	Effect.gen(function* () {
		const existing = yield* on(sql, {
			sqlite: () => {
				throw new Error("Remote schema check requires PostgreSQL or MySQL");
			},
			pg: () =>
				sql`SELECT a.attname AS name,CASE WHEN i.indisunique THEN 1 ELSE 0 END AS "unique",m.amname AS method,CASE WHEN i.indisvalid AND i.indisready THEN 1 ELSE 0 END AS valid,CASE WHEN i.indpred IS NULL AND i.indexprs IS NULL AND i.indnatts=i.indnkeyatts THEN 0 ELSE 1 END AS partial,NULL::integer AS prefix FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace JOIN pg_catalog.pg_index i ON i.indrelid=t.oid JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid JOIN pg_catalog.pg_am m ON m.oid=x.relam JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,position) ON true JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum WHERE n.nspname='public' AND t.relname=${table} AND x.relname=${index} ORDER BY k.position`,
			mysql: () =>
				sql`SELECT COLUMN_NAME AS name,(1-NON_UNIQUE) AS ${sql("unique")},INDEX_TYPE AS method,1 AS valid,0 AS partial,SUB_PART AS prefix FROM information_schema.statistics WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} AND INDEX_NAME=${index} ORDER BY SEQ_IN_INDEX`,
		}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(indexRows)));
		if (existing.length === 0) return false;
		if (
			existing.length !== columns.length ||
			existing.some(
				(row, i) =>
					row.name !== columns[i] ||
					(row.unique === 1) !== unique ||
					row.method !== (method ?? on(sql, { sqlite: () => "btree", pg: () => "btree", mysql: () => "BTREE" })) ||
					row.valid !== 1 ||
					row.partial !== 0 ||
					row.prefix !== null,
			)
		)
			return yield* new SchemaShapeError({ object: index });
		return true;
	});
