import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, KernelError } from "./boot-channel.ts";

export const SqlReadInput = Schema.Struct({
	sql: Schema.String,
	params: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Finite, Schema.Null]))),
});
export const SqlReadResult = Schema.Struct({
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Null]))),
	truncated: Schema.Boolean,
});

/** Physical committed-row inspection; deliberately does not promise a publication cursor. */
export const readSql = (input: typeof SqlReadInput.Type) =>
	Effect.gen(function* () {
		const boot = yield* BootChannel;
		const params = input.params ?? [];
		if (
			input.sql.length === 0 ||
			new TextEncoder().encode(input.sql).byteLength > 16384 ||
			params.length > 100 ||
			params.some(
				(value) =>
					typeof value === "number" &&
					(!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))),
			)
		)
			return yield* new KernelError({ code: "input_invalid" });
		// Conservatively reject separators and comments even inside literals. Bind such text as a parameter.
		// Without them the caller cannot discard the wrapper's final LIMIT or introduce another statement.
		if (!/^(SELECT|WITH)\b/i.test(input.sql.trim()) || /;|--|\/\*|\*\/|\0/.test(input.sql)) return null;
		return yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const result = yield* sql
				.unsafe<Record<string, unknown>>(`SELECT * FROM (${input.sql}\n) LIMIT 201`, params)
				.pipe(
					Effect.provideService(SqlClient.SafeIntegers, true),
					Effect.mapError(() => new KernelError({ code: "query_invalid" })),
				);
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
						return yield* new KernelError({ code: "query_invalid" });
					entries.push([key, value]);
				}
				rows.push(Object.fromEntries(entries));
			}
			const response = { rows, truncated: result.length > 200 };
			if (
				new TextEncoder().encode(yield* Schema.encodeEffect(Schema.fromJsonString(SqlReadResult))(response))
					.byteLength > 131072
			)
				return yield* new KernelError({ code: "query_invalid" });
			return response;
		}).pipe(
			Effect.provide(
				SqliteClient.layer({ filename: boot.filename, readonly: true, disableWAL: true, busyTimeout: "100 millis" }),
			),
		);
	});
