import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import type { SqlInput } from "./sql-input.ts";
import { sqlRows } from "./sql-result.ts";
import { remoteWriteGuard, remoteWriteTarget } from "./sql-write-remote-guard.ts";

/** Invoked only inside mutate's writer-gated transaction, before its outbox/receipt inserts. */
export const writeRemoteSql = (
	sql: SqlClient.SqlClient,
	dialect: "pg" | "mysql",
	input: typeof SqlInput.Type,
	protectedTables: ReadonlyArray<string>,
) =>
	Effect.gen(function* () {
		if (
			(input.params?.length ?? 0) > 0 &&
			(dialect === "pg"
				? input.sql.includes("?") && !/\$[1-9][0-9]*/.test(input.sql)
				: /\$[1-9][0-9]*/.test(input.sql) && !input.sql.includes("?"))
		)
			return yield* new KernelError({ code: "placeholder_style" });
		const target = yield* remoteWriteTarget(input.sql, dialect);
		const verify = yield* remoteWriteGuard(sql, dialect, protectedTables, target);
		const raw = yield* sql
			.unsafe(input.sql, input.params ?? [])
			.raw.pipe(
				Effect.mapError((error) => (error.isRetryable ? error : new KernelError({ code: "sql_query_invalid" }))),
			);
		const result =
			dialect === "pg"
				? yield* Schema.decodeUnknownEffect(
						Schema.Struct({ rowCount: Schema.Int, rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
					)(raw).pipe(Effect.map(({ rowCount, rows }) => ({ changes: rowCount, rows })))
				: yield* Schema.decodeUnknownEffect(Schema.Struct({ affectedRows: Schema.Int }))(raw).pipe(
						Effect.map(({ affectedRows }) => ({ changes: affectedRows, rows: [] })),
					);
		if (!Number.isSafeInteger(result.changes) || result.changes < 0)
			return yield* new KernelError({ code: "sql_query_invalid" });
		const rows = yield* sqlRows(result.rows);
		yield* verify;
		return { ...rows, changes: result.changes, changes_scope: "direct" as const, dialect };
	});
