import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "./dialect.ts";
export interface ColumnShape {
	readonly name: string;
	readonly type: string;
	readonly nullable: boolean;
	readonly length?: number;
	readonly expression?: string;
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
	}),
);
const indexRows = Schema.Array(Schema.Struct({ name: Schema.String, unique: Schema.Finite, method: Schema.String }));
/** Catalog checks never adopt unknown pre-existing objects; migration intent establishes ownership. */
export const tableShape = (
	sql: SqlClient,
	table: string,
	columns: ReadonlyArray<ColumnShape>,
	primaryKey: ReadonlyArray<string> = [],
) =>
	Effect.gen(function* () {
		const existing = yield* on(sql, {
			sqlite: () => {
				throw new Error("Remote schema check requires PostgreSQL or MySQL");
			},
			pg: () =>
				sql`SELECT column_name AS name,CASE WHEN data_type='USER-DEFINED' THEN udt_name ELSE data_type END AS type,is_nullable AS nullable,character_maximum_length AS length,generation_expression AS expression FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} ORDER BY ordinal_position`,
			mysql: () =>
				sql`SELECT COLUMN_NAME AS name,DATA_TYPE AS type,IS_NULLABLE AS nullable,CHARACTER_MAXIMUM_LENGTH AS length,GENERATION_EXPRESSION AS expression FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} ORDER BY ORDINAL_POSITION`,
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
					(expected.expression !== undefined && actual.expression !== expected.expression)
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
				sql`SELECT a.attname AS name,CASE WHEN i.indisunique THEN 1 ELSE 0 END AS unique,m.amname AS method FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace JOIN pg_catalog.pg_index i ON i.indrelid=t.oid JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid JOIN pg_catalog.pg_am m ON m.oid=x.relam JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,position) ON true JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum WHERE n.nspname='public' AND t.relname=${table} AND x.relname=${index} ORDER BY k.position`,
			mysql: () =>
				sql`SELECT COLUMN_NAME AS name,(1-NON_UNIQUE) AS ${sql("unique")},INDEX_TYPE AS method FROM information_schema.statistics WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} AND INDEX_NAME=${index} ORDER BY SEQ_IN_INDEX`,
		}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(indexRows)));
		if (existing.length === 0) return false;
		if (
			existing.length !== columns.length ||
			existing.some(
				(row, i) =>
					row.name !== columns[i] || (row.unique === 1) !== unique || (method !== undefined && row.method !== method),
			)
		)
			return yield* new SchemaShapeError({ object: index });
		return true;
	});
