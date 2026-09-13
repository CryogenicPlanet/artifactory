import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import { sqlInput, type SqlInput } from "./sql-input.ts";
import { sqlRows } from "./sql-result.ts";

/** One physical connection owns the read-only transaction through rollback and scope closure. */
export const remoteRead = (input: typeof SqlInput.Type, allowRead: boolean, dialect: "pg" | "mysql") =>
	Effect.gen(function* () {
		yield* sqlInput(input);
		if (!/^(SELECT|WITH)\b/i.test(input.sql.trim())) return yield* new KernelError({ code: "sql_unsupported" });
		if (!allowRead) return yield* new KernelError({ code: "scope_required" });
		// Diagnose obvious mismatches without mistaking PostgreSQL's JSON ? operator for a placeholder.
		if (
			(input.params?.length ?? 0) > 0 &&
			(dialect === "pg"
				? input.sql.includes("?") && !/\$[1-9][0-9]*/.test(input.sql)
				: /\$[1-9][0-9]*/.test(input.sql) && !input.sql.includes("?"))
		)
			return yield* new KernelError({ code: "placeholder_style" });
		const sql = yield* SqlClient.SqlClient;
		const connection = yield* sql.reserve;
		return yield* Effect.acquireUseRelease(
			connection.executeUnprepared("START TRANSACTION READ ONLY", [], undefined),
			() =>
				Effect.gen(function* () {
					const rows = yield* connection
						.execute(`SELECT * FROM (${input.sql}\n) AS q LIMIT 201`, input.params ?? [], undefined)
						.pipe(
							Effect.mapError((error) => (error.isRetryable ? error : new KernelError({ code: "sql_query_invalid" }))),
						);
					return { kind: "read" as const, result: { ...(yield* sqlRows(rows)), dialect } };
				}),
			// Never return a query result while this lease still owns an open transaction.
			() => connection.executeUnprepared("ROLLBACK", [], undefined).pipe(Effect.orDie),
		);
	});
