import { Effect, Schema, Stream } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "./dialect.ts";
import { TransferCopyError, type TransferTablePlan } from "./transfer-plan.ts";
import { transferBinding, transferOrder, transferProjection } from "./transfer-projection.ts";
import { decodeTransferValue, type TransferValue } from "./transfer-values.ts";

export const sqliteTransferPage = (
	sql: SqlClient,
	plan: TransferTablePlan,
	previous: readonly TransferValue[] | undefined,
) => {
	const order = transferOrder(sql, plan);
	const after =
		previous === undefined
			? sql`1=1`
			: sql`(${order}) > (${sql.join(",", false)(previous.map((value) => transferBinding(sql, value)))})`;
	return sql<
		Readonly<Record<string, unknown>>
	>`SELECT ${transferProjection(sql, plan)} FROM ${sql(plan.name)} WHERE ${after} ORDER BY ${order} LIMIT 1`;
};

/** Caller owns a stable read transaction. Remote drivers implement scoped, backpressured streams;
 * SQLite's Effect driver explicitly does not, so seek from the previous logical key instead.
 */
export const readTransferRows = <E, R>(
	sql: SqlClient,
	plan: TransferTablePlan,
	consume: (raw: Readonly<Record<string, unknown>>) => Effect.Effect<void, E, R>,
) =>
	Effect.gen(function* () {
		const order = transferOrder(sql, plan);
		if (!on(sql, { sqlite: () => true, pg: () => false, mysql: () => false })) {
			return yield* Stream.runForEach(
				sql<
					Readonly<Record<string, unknown>>
				>`SELECT ${transferProjection(sql, plan)} FROM ${sql(plan.name)} ORDER BY ${order}`.stream,
				consume,
			);
		}
		const encodings = yield* sql`PRAGMA encoding`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ encoding: Schema.String })))),
		);
		if (encodings.length !== 1 || encodings[0]?.encoding !== "UTF-8")
			return yield* new TransferCopyError({ code: "transfer_plan_invalid" });
		let previous: readonly TransferValue[] | undefined;
		while (true) {
			const rows = yield* sqliteTransferPage(sql, plan, previous);
			const row = rows[0];
			if (!row) return;
			yield* consume(row);
			const key: TransferValue[] = [];
			for (const name of plan.key) {
				const column = plan.columns.find((entry) => entry.name === name);
				if (!column) return yield* new TransferCopyError({ code: "transfer_plan_invalid" });
				const value = yield* decodeTransferValue(column.kind, row[name]);
				if (value.kind === "null") return yield* new TransferCopyError({ code: "transfer_value_invalid" });
				key.push(value);
			}
			previous = key;
		}
	});
