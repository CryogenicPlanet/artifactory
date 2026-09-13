import { on } from "@comms/storage/dialect";
import { writeRemoteSql } from "./sql-write-remote.ts";
import { remoteWriteTarget } from "./sql-write-remote-guard.ts";
import { type Crypto, DateTime, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type BootChannel, KernelError } from "./boot-channel.ts";
import type { Identity } from "./identity.ts";
import type { Mutate } from "./mutate.ts";
import { sqlInput, sqlQueryFailure, type SqlInput } from "./sql-input.ts";
import { preserveMigrationState } from "./migration-state.ts";
import { sqlTableTargets } from "./sql-table-targets.ts";
import { kernelSqlTables, protectedSqlTables } from "./protected-sql-tables.ts";
import { SqlRows, sqlRows } from "./sql-result.ts";

export const SqlWriteResult = Schema.Struct({
	...SqlRows.fields,
	changes: Schema.Int,
	seq: Schema.Int,
	changes_scope: Schema.optionalKey(Schema.Literal("direct")),
	dialect: Schema.optionalKey(Schema.Literals(["pg", "mysql"])),
});
export const writeShape = (input: typeof SqlInput.Type, protectedTables: ReadonlyArray<string> = kernelSqlTables) =>
	Effect.gen(function* () {
		yield* sqlInput(input);
		if (
			!/^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|WITH)\b/i.test(input.sql.trim()) ||
			/\b(?:pragma|attach|detach|vacuum|rollback|load_extension|trigger|temp|temporary|sqlite_master|sqlite_schema|sqlite_temp_master|sqlite_temp_schema)\b/i.test(
				input.sql,
			) ||
			sqlTableTargets(input.sql).some((name) => protectedTables.includes(name))
		)
			return yield* new KernelError({ code: "sql_unsupported" });
	});

/** Domain SQL runs inside the same epoch, receipt and outbox protocol as every other mutation. */
export const writeSql = (
	sql: SqlClient.SqlClient,
	mutate: Mutate,
	crypto: Crypto.Crypto,
	boot: BootChannel["Service"],
	who: Identity,
	input: typeof SqlInput.Type,
	key?: string,
) =>
	Effect.gen(function* () {
		yield* writeShape(input);
		const dialect = on(sql, {
			sqlite: () => "sqlite" as const,
			pg: () => "pg" as const,
			mysql: () => "mysql" as const,
		});
		if (dialect !== "sqlite") yield* remoteWriteTarget(input.sql, dialect);
		if (key !== undefined && (key.length < 1 || key.length > 200))
			return yield* new KernelError({ code: "input_invalid" });
		const normalized = yield* Schema.encodeEffect(
			Schema.fromJsonString(
				Schema.Struct({
					sql: Schema.String,
					params: Schema.Array(Schema.Union([Schema.String, Schema.Finite, Schema.Null])),
				}),
			),
		)({ sql: input.sql, params: input.params ?? [] });
		const digest = Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(input.sql))).toString("hex");
		return yield* mutate({
			...(key === undefined
				? {}
				: {
						idempotency: {
							instance: who.instance,
							key,
							kind: "sql.write",
							input: normalized,
							outcome: Schema.fromJsonString(SqlWriteResult),
						},
					}),
			body: (reserve) =>
				Effect.gen(function* () {
					const protectedTables = yield* protectedSqlTables(sql);
					yield* writeShape(input, protectedTables);
					const range = yield* reserve(1);
					const result = yield* dialect === "sqlite"
						? Effect.gen(function* () {
								const count = sql`SELECT total_changes() AS count`.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ count: Schema.Int })))),
									Effect.map((rows) => rows[0]?.count ?? 0),
								);
								const before = yield* count;
								const raw = yield* preserveMigrationState(
									sql,
									sql
										.unsafe<Record<string, unknown>>(input.sql, input.params ?? [])
										.pipe(Effect.provideService(SqlClient.SafeIntegers, true), Effect.mapError(sqlQueryFailure)),
									protectedTables,
								).pipe(
									Effect.mapError((error) =>
										error instanceof KernelError && error.code === "extension_migration_invalid"
											? new KernelError({ code: "sql_unsupported" })
											: error,
									),
								);
								const changes = (yield* count) - before;
								const rows = yield* sqlRows(raw);
								return { ...rows, changes };
							})
						: writeRemoteSql(sql, dialect, input, protectedTables);
					const outcome = { ...result, seq: range.from };
					return {
						outcome,
						events: [
							{
								seq: range.from,
								at: (yield* DateTime.nowAsDate).getTime(),
								type: "sql.write",
								level: "info",
								actor: who.agent,
								instance: who.instance,
								generation: boot.generation,
								request_id: who.request,
								topic: null,
								message_id: null,
								payload: {
									operation: input.sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "SQL",
									statement_sha256: digest,
									parameter_count: input.params?.length ?? 0,
									changes: result.changes,
									...(dialect === "sqlite" ? {} : { dialect, changes_scope: "direct" }),
								},
							},
						],
					};
				}),
		});
	});
