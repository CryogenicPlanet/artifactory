import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "./dialect.ts";
import { TransferCopyError } from "./transfer-plan.ts";

const lengthPrefix = (length: number) => (length < 251 ? 1 : length < 65536 ? 3 : length < 16777216 ? 4 : 9);
const invalid = () => new TransferCopyError({ code: "transfer_value_invalid" });
export const transferPacketLimit = (sql: SqlClient) =>
	Effect.gen(function* () {
		if (!on(sql, { sqlite: () => false, pg: () => false, mysql: () => true })) return null;
		const rows = yield* sql`SELECT CAST(@@session.max_allowed_packet AS CHAR) AS value`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
		);
		const value = rows[0]?.value;
		if (!value || !/^[1-9][0-9]*$/.test(value)) return yield* invalid();
		return BigInt(value);
	});

/** mysql2 uses prepared statements: COM_STMT_PREPARE carries SQL and COM_STMT_EXECUTE carries
 * binary parameters. Bound their framed payload sizes, including negotiated query attributes, not an arbitrary board or row budget.
 */
export const validateTransferPacket = (compiled: readonly [string, readonly unknown[]], limit: bigint) =>
	Effect.gen(function* () {
		const [query, parameters] = compiled;
		let executeBytes =
			14 +
			lengthPrefix(parameters.length) +
			(parameters.length ? Math.ceil(parameters.length / 8) + 1 + 3 * parameters.length : 0);
		for (const value of parameters) {
			if (value === null) continue;
			if (typeof value === "number") {
				executeBytes += 8;
				continue;
			}
			const length =
				typeof value === "string"
					? new TextEncoder().encode(value).byteLength
					: value instanceof Uint8Array
						? value.byteLength
						: undefined;
			if (length === undefined) return yield* invalid();
			executeBytes += length + lengthPrefix(length);
		}
		const prepareBytes = 5 + new TextEncoder().encode(query).byteLength;
		if (!Number.isSafeInteger(executeBytes) || BigInt(executeBytes) > limit || BigInt(prepareBytes) > limit)
			return yield* invalid();
	});
