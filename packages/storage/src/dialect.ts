import { Effect, Option } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Constructor, Fragment, Identifier } from "effect/unstable/sql/Statement";

/** Values are bound; pass sql("column") for identifiers and sql`...` for expressions. */
type Expression = Fragment | Identifier | string | number | null;

export const on = <A>(
	sql: Constructor,
	branches: { readonly sqlite: () => A; readonly pg: () => A; readonly mysql: () => A },
): A =>
	sql.onDialectOrElse({
		...branches,
		orElse: () => {
			throw new Error("Unsupported SQL dialect");
		},
	});

export const nullable = (sql: Constructor, value: string | null) =>
	on(sql, { sqlite: () => sql`${value}`, pg: () => sql`${value}::text`, mysql: () => sql`${value}` });

export const isDescendant = (sql: Constructor, child: Expression, ancestor: Expression) =>
	on(sql, {
		sqlite: () => sql`substr(${child},1,length(${ancestor})+1)=${ancestor}||'/'`,
		pg: () => sql`starts_with(${child}::text,${ancestor}::text||'/')`,
		mysql: () => sql`BINARY substr(${child},1,char_length(${ancestor})+1)=BINARY CONCAT(${ancestor},'/')`,
	});

export const replacePrefix = (sql: Constructor, column: Expression, from: Expression, to: Expression) =>
	on(sql, {
		sqlite: () => sql`${to}||substr(${column},length(${from})+1)`,
		pg: () => sql`${to}::text||substr(${column}::text,length(${from}::text)+1)`,
		mysql: () => sql`CONCAT(${to},substr(${column},char_length(${from})+1))`,
	});

/** Keys are single top-level members, never SQL or JSON path expressions. */
export const jsonText = (sql: Constructor, column: Expression, key: string) => {
	const path = `$.${JSON.stringify(key)}`;
	return on(sql, {
		sqlite: () => sql`json_extract(${column},${path})`,
		pg: () => sql`(${column}::jsonb ->> ${key})`,
		// JSON null becomes SQL NULL, while the JSON string "null" stays a string.
		mysql: () =>
			sql`CASE WHEN JSON_TYPE(JSON_EXTRACT(${column},${path}))='NULL' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(${column},${path})) END`,
	});
};

export const jsonInt = (sql: Constructor, column: Expression, key: string) =>
	on(sql, {
		sqlite: () => jsonText(sql, column, key),
		pg: () => sql`(${jsonText(sql, column, key)})::bigint`,
		mysql: () => sql`CAST((${jsonText(sql, column, key)}) AS SIGNED)`,
	});

/** Membership in the string arrays used for tags and mentions. */
export const jsonArrayHas = (sql: Constructor, column: Expression, value: string | null) =>
	on(sql, {
		sqlite: () => sql`EXISTS(SELECT 1 FROM json_each(${column}) WHERE value=${value})`,
		pg: () =>
			sql`EXISTS(SELECT 1 FROM jsonb_array_elements_text(${column}::jsonb) AS element(value) WHERE value=${value}::text)`,
		mysql: () => sql`JSON_CONTAINS(${column},JSON_QUOTE(${value}),'$')`,
	});

/** Non-null sequence numbers only; engines differ on nullable GREATEST arguments. */
export const greatest = (sql: Constructor, a: Expression, b: Expression) =>
	on(sql, {
		sqlite: () => sql`MAX(${a},${b})`,
		pg: () => sql`GREATEST(${a},${b})`,
		mysql: () => sql`GREATEST(${a},${b})`,
	});

export const distinctFrom = (sql: Constructor, a: Expression, b: Expression) =>
	on(sql, {
		sqlite: () => sql`${a} IS NOT ${b}`,
		pg: () => sql`${a}::text IS DISTINCT FROM ${b}::text`,
		mysql: () => sql`NOT (${a} <=> ${b})`,
	});

/** Literal, case-sensitive prefix; %, _, *, ? and [ carry no pattern meaning. */
export const globPrefix = (sql: Constructor, column: Expression, prefix: string) =>
	on(sql, {
		sqlite: () => sql`substr(${column},1,length(${prefix}))=${prefix}`,
		pg: () => sql`starts_with(${column}::text,${prefix}::text)`,
		mysql: () => sql`BINARY substr(${column},1,char_length(${prefix}))=BINARY ${prefix}`,
	});

export const plannerHint = (sql: Constructor, index: string | null) =>
	on(sql, {
		sqlite: () => (index === null ? sql`NOT INDEXED` : sql`INDEXED BY ${sql(index)}`),
		pg: () => sql``,
		mysql: () => sql``,
	});

/** Append only to a read inside a write transaction. SQLite already serializes writers. */
export const lockRow = (sql: Constructor) =>
	on(sql, {
		sqlite: () => sql``,
		pg: () => sql`FOR UPDATE`,
		mysql: () => sql`FOR UPDATE`,
	});

/** Nested reads inherit the enclosing transaction's isolation, without changing it. */
export const readTransaction = <A, E, R>(sql: SqlClient, effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const nested = Option.isSome(yield* Effect.serviceOption(sql.transactionService));
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				if (!nested)
					yield* on(sql, {
						sqlite: () => Effect.void,
						pg: () => sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`.pipe(Effect.asVoid),
						// Client startup must assert MySQL REPEATABLE-READ; SET TRANSACTION inside BEGIN is invalid.
						mysql: () => Effect.void,
					});
				return yield* effect;
			}),
		);
	});
