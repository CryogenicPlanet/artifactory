import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "./dialect.ts";
import { transferJsonCanonical } from "./transfer-json.ts";
import { TransferCopyError } from "./transfer-plan.ts";
import type { TransferTablePlan } from "./transfer-plan.ts";
import { transferInsert } from "./transfer-projection.ts";
import { validateTransferPacket } from "./transfer-packet.ts";
import type { TransferValue } from "./transfer-values.ts";

/** Read-only destination round-trips detect native JSON numeric limits and normalization loss. */
export const validateTransferTargetValues = (
	sql: SqlClient,
	plan: TransferTablePlan,
	rows: readonly (readonly TransferValue[])[],
	packetLimit: bigint | null,
) =>
	Effect.gen(function* () {
		for (const row of rows) {
			if (packetLimit !== null) yield* validateTransferPacket(transferInsert(sql, plan, row).compile(), packetLimit);
			for (const value of row) {
				if (value.kind !== "json") continue;
				const query = on(sql, {
					sqlite: () => sql`SELECT ${value.value} AS value`,
					pg: () => sql`SELECT (${value.value}::jsonb)::text AS value`,
					mysql: () => sql`SELECT CAST(CAST(${value.value} AS JSON) AS CHAR CHARACTER SET utf8mb4) AS value`,
				});
				if (packetLimit !== null) yield* validateTransferPacket(query.compile(), packetLimit);
				const result = yield* query.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
				);
				const actual = result[0];
				if (
					result.length !== 1 ||
					!actual ||
					(yield* transferJsonCanonical(actual.value)) !== (yield* transferJsonCanonical(value.value))
				)
					return yield* new TransferCopyError({ code: "transfer_value_invalid" });
			}
		}
	});
