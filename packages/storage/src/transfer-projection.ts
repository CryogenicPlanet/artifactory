import { Buffer } from "node:buffer";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "./dialect.ts";
import { TransferCopyError, type TransferEngine, type TransferTablePlan } from "./transfer-plan.ts";
import type { TransferColumn, TransferTable } from "./transfer-schema.ts";
import { decodeTransferValue, type TransferValue } from "./transfer-values.ts";

const invalid = () => new TransferCopyError({ code: "transfer_plan_invalid" });
const valueInvalid = () => new TransferCopyError({ code: "transfer_value_invalid" });
export const integerLimit = (column: TransferColumn, engine: TransferEngine): bigint | undefined => {
	if (engine === "sqlite") return 9223372036854775807n;
	const type = column.declaration.toLowerCase();
	if (/unsigned/.test(type)) return undefined;
	if (/^(bigint|int8)\b/.test(type)) return 9223372036854775807n;
	if (/^(smallint|int2)\b/.test(type)) return 32767n;
	if (/^(integer|int|int4)\b/.test(type)) return 2147483647n;
	if (engine === "mysql" && /^tinyint\b/.test(type)) return 127n;
	if (engine === "mysql" && /^mediumint\b/.test(type)) return 8388607n;
	return undefined;
};

export const validateTransferPlan = (plan: TransferTablePlan, target: TransferTable, engine: TransferEngine) =>
	Effect.gen(function* () {
		if (
			plan.name !== target.name ||
			!plan.name ||
			!plan.columns.length ||
			!plan.key.length ||
			new Set(plan.columns.map((column) => column.name)).size !== plan.columns.length ||
			new Set(plan.key).size !== plan.key.length ||
			new Set(plan.identities).size !== plan.identities.length
		)
			return yield* invalid();
		for (const column of plan.columns) {
			const physical = target.columns.find((entry) => entry.name === column.name);
			if (
				!column.name ||
				!physical ||
				physical.generated ||
				physical.kind !== column.kind ||
				physical.nullable !== column.nullable ||
				(column.kind === "integer" && integerLimit(physical, engine) === undefined)
			)
				return yield* invalid();
		}
		for (const key of plan.key) {
			const column = plan.columns.find((entry) => entry.name === key);
			if (!column || !["integer", "text", "bytes"].includes(column.kind)) return yield* invalid();
		}
		for (const identity of plan.identities) {
			const column = target.columns.find((entry) => entry.name === identity);
			if (!column?.identity || column.kind !== "integer" || !plan.columns.some((entry) => entry.name === identity))
				return yield* invalid();
		}
	});

export const transferProjection = (sql: SqlClient, plan: TransferTablePlan) =>
	sql.join(
		",",
		false,
	)(
		plan.columns.map((column) => {
			const name = sql(column.name);
			const value =
				column.kind === "integer"
					? on(sql, {
							sqlite: () =>
								sql`CASE WHEN typeof(${name}) IN ('integer','null') THEN CAST(${name} AS TEXT) ELSE 'invalid' END`,
							pg: () => sql`${name}::text`,
							mysql: () => sql`CAST(${name} AS CHAR CHARACTER SET utf8mb4)`,
						})
					: column.kind === "json"
						? on(sql, {
								sqlite: () => sql`${name}`,
								pg: () => sql`${name}::text`,
								mysql: () => sql`CAST(${name} AS CHAR CHARACTER SET utf8mb4)`,
							})
						: sql`${name}`;
			return sql`${value} AS ${name}`;
		}),
	);

export const transferOrder = (sql: SqlClient, plan: TransferTablePlan) =>
	sql.join(
		",",
		false,
	)(
		plan.key.map((key) => {
			const column = plan.columns.find((entry) => entry.name === key);
			const name = sql`${sql(plan.name)}.${sql(key)}`;
			return column?.kind === "text"
				? on(sql, {
						sqlite: () => sql`CAST(${name} AS BLOB)`,
						pg: () => sql`convert_to(${name},'UTF8')`,
						mysql: () => sql`CAST(${name} AS BINARY)`,
					})
				: sql`${name}`;
		}),
	);

export const decodeTransferRow = (
	raw: Readonly<Record<string, unknown>>,
	plan: TransferTablePlan,
	target: TransferTable,
	engine: TransferEngine,
) =>
	Effect.gen(function* () {
		const row: TransferValue[] = [];
		for (const column of plan.columns) {
			const physical = target.columns.find((entry) => entry.name === column.name);
			if (!physical) return yield* invalid();
			const value = yield* decodeTransferValue(column.kind, raw[column.name]);
			if (value.kind === "null" && (!column.nullable || plan.key.includes(column.name))) return yield* valueInvalid();
			if (value.kind === "integer") {
				const limit = integerLimit(physical, engine);
				const integer = BigInt(value.value);
				if (
					limit === undefined ||
					integer < -limit - 1n ||
					integer > limit ||
					(plan.identities.includes(column.name) && integer === limit)
				)
					return yield* valueInvalid();
				if (engine === "mysql" && integer === 0n && plan.identities.includes(column.name)) return yield* valueInvalid();
			}
			if (value.kind === "bytes" && physical.length !== undefined && value.value.byteLength > physical.length)
				return yield* valueInvalid();
			if (value.kind === "text") {
				if (
					(engine === "pg" && value.value.includes("\0")) ||
					(physical.length !== undefined && Array.from(value.value).length > physical.length)
				)
					return yield* valueInvalid();
			}
			// Single precision destinations cannot preserve arbitrary binary64 values.
			if (
				value.kind === "real" &&
				engine !== "sqlite" &&
				/^(real|float(\(|$))/.test(physical.declaration.toLowerCase()) &&
				!Object.is(Math.fround(value.value), value.value)
			)
				return yield* valueInvalid();
			row.push(value);
		}
		return row;
	});

/** Exact integer text is cast by the destination, never rounded through JavaScript Number. */
export const transferBinding = (sql: SqlClient, value: TransferValue) => {
	if (value.kind === "integer")
		return on(sql, {
			sqlite: () => sql`CAST(${value.value.toString()} AS INTEGER)`,
			pg: () => sql`${value.value.toString()}::bigint`,
			mysql: () => sql`CAST(${value.value.toString()} AS SIGNED)`,
		});
	if (value.kind === "json")
		return on(sql, {
			sqlite: () => sql`${value.value}`,
			pg: () => sql`${value.value}::jsonb`,
			mysql: () => sql`${value.value}`,
		});
	if (value.kind === "bytes")
		return on(sql, {
			sqlite: () => sql`${value.value}`,
			pg: () => sql`${value.value}`,
			mysql: () => sql`${Buffer.from(value.value)}`,
		});
	return sql`${value.value}`;
};

export const transferInsert = (sql: SqlClient, plan: TransferTablePlan, row: readonly TransferValue[]) => {
	const override = on(sql, { sqlite: () => sql``, mysql: () => sql``, pg: () => sql`OVERRIDING SYSTEM VALUE` });
	return sql`INSERT INTO ${sql(plan.name)} (${sql.join(",", false)(plan.columns.map((column) => sql`${sql(column.name)}`))}) ${override} VALUES (${sql.join(",", false)(row.map((value) => transferBinding(sql, value)))})`;
};
