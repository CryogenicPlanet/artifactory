import { on } from "@comms/storage/dialect";
import { Effect, Schema, Stream } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

export class CoreJsonSchemaError extends Schema.TaggedError<CoreJsonSchemaError>()("CoreJsonSchemaError", {
	code: Schema.Literals(["core_json_invalid", "core_json_shape_invalid"]),
}) {}
const columns = [
	{ table: "messages", column: "tags" },
	{ table: "messages", column: "meta" },
	{ table: "topics", column: "meta" },
] as const;
const row = Schema.Struct({ value: Schema.String });
const tags = Schema.fromJsonString(Schema.Array(Schema.String));
const meta = Schema.fromJsonString(Schema.JsonObject);
const shape = Schema.Array(
	Schema.Struct({
		type: Schema.String,
		nullable: Schema.String,
		default: Schema.NullOr(Schema.String),
		expression: Schema.NullOr(Schema.String),
		collation: Schema.NullOr(Schema.String),
	}),
);

/** Only domain values change representation. Encoded events, receipts and previous images stay text. */
export const coreJsonOperations = (sql: SqlClient) => {
	const mysql = on(sql, { sqlite: () => false, pg: () => false, mysql: () => true });
	const inspect = (table: string, column: string) =>
		Effect.gen(function* () {
			const existing = yield* (
				mysql
					? sql`SELECT DATA_TYPE AS type,IS_NULLABLE AS nullable,COLUMN_DEFAULT AS ${sql("default")},GENERATION_EXPRESSION AS expression,COLLATION_NAME AS collation FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} AND COLUMN_NAME=${column}`
					: sql`SELECT data_type AS type,is_nullable AS nullable,column_default AS "default",generation_expression AS expression,collation_name AS collation FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} AND column_name=${column}`
			).pipe(Effect.flatMap(Schema.decodeUnknownEffect(shape)));
			const actual = existing[0];
			const old = mysql ? "longtext" : "text";
			const target = mysql ? "json" : "jsonb";
			if (
				existing.length !== 1 ||
				!actual ||
				actual.nullable !== "NO" ||
				actual.default !== null ||
				(actual.expression !== null && actual.expression !== "") ||
				(actual.type !== old && actual.type !== target) ||
				actual.collation !== (mysql && actual.type === old ? "utf8mb4_0900_bin" : null)
			)
				return yield* new CoreJsonSchemaError({ code: "core_json_shape_invalid" });
			return actual.type === target;
		});
	// Scan the whole domain before the first ALTER, without retaining rows or imposing a board-size limit.
	// Repeating this on an interrupted MySQL upgrade also validates any still-text columns.
	const validate = Effect.gen(function* () {
		for (const { table, column } of columns) yield* inspect(table, column);
		for (const { table, column } of columns) {
			const value = mysql ? sql`CAST(${sql(column)} AS CHAR)` : sql`${sql(column)}::text`;
			yield* sql`SELECT ${value} AS value FROM ${sql(table)}`.stream.pipe(
				Stream.runForEach((input) =>
					Schema.decodeUnknownEffect(row)(input).pipe(
						Effect.flatMap(({ value }) =>
							column === "tags"
								? Schema.decodeEffect(tags)(value).pipe(Effect.asVoid)
								: Schema.decodeEffect(meta)(value).pipe(Effect.asVoid),
						),
						Effect.mapError(() => new CoreJsonSchemaError({ code: "core_json_invalid" })),
					),
				),
			);
		}
	});
	return columns.map(({ table, column }) => ({
		name: `${table}_${column}_json`,
		run: Effect.gen(function* () {
			yield* validate;
			yield* mysql
				? sql`ALTER TABLE ${sql(table)} MODIFY COLUMN ${sql(column)} JSON NOT NULL`
				: sql`ALTER TABLE ${sql(table)} ALTER COLUMN ${sql(column)} TYPE jsonb USING ${sql(column)}::jsonb`;
		}),
		postcondition: inspect(table, column),
	}));
};
