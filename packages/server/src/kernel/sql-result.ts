import { Effect, Schema } from "effect";
import { KernelError } from "./boot-channel.ts";

export const SqlRows = Schema.Struct({
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Null]))),
	truncated: Schema.Boolean,
});
export const sqlRows = (result: ReadonlyArray<Record<string, unknown>>) =>
	Effect.gen(function* () {
		const rows: Array<Record<string, string | number | null>> = [];
		for (const source of result.slice(0, 200)) {
			const entries: Array<[string, string | number | null]> = [];
			for (const [key, raw] of Object.entries(source)) {
				const value =
					typeof raw === "bigint" && raw >= BigInt(Number.MIN_SAFE_INTEGER) && raw <= BigInt(Number.MAX_SAFE_INTEGER)
						? Number(raw)
						: raw;
				if (
					value !== null &&
					typeof value !== "string" &&
					(typeof value !== "number" ||
						!Number.isFinite(value) ||
						(Number.isInteger(value) && !Number.isSafeInteger(value)))
				)
					return yield* new KernelError({ code: "sql_query_invalid" });
				entries.push([key, value]);
			}
			rows.push(Object.fromEntries(entries));
		}
		const response = { rows, truncated: result.length > 200 };
		if (
			new TextEncoder().encode(yield* Schema.encodeEffect(Schema.fromJsonString(SqlRows))(response)).byteLength > 130000
		)
			return yield* new KernelError({ code: "sql_query_invalid" });
		return response;
	});
