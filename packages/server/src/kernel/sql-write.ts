import { type Crypto, DateTime, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type BootChannel, KernelError } from "./boot-channel.ts";
import type { Identity } from "./identity.ts";
import type { Mutate } from "./mutate.ts";
import { sqlInput, sqlQueryFailure, type SqlInput } from "./sql-input.ts";
import { kernelSqlTables, protectedSqlTables } from "./protected-sql-tables.ts";
import { SqlRows, sqlRows } from "./sql-result.ts";

export const SqlWriteResult = Schema.Struct({ ...SqlRows.fields, changes: Schema.Int, seq: Schema.Int });
export const writeShape = (input: typeof SqlInput.Type, protectedTables: ReadonlyArray<string> = kernelSqlTables) =>
	Effect.gen(function* () {
		yield* sqlInput(input);
		if (
			!/^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|WITH)\b/i.test(input.sql.trim()) ||
			/\b(?:pragma|attach|detach|vacuum|rollback|load_extension|trigger|temp|temporary|sqlite_master|sqlite_schema|sqlite_temp_master|sqlite_temp_schema)\b/i.test(
				input.sql,
			) ||
			protectedTables.some((name) => new RegExp(`\\b${name}(?:\\b|_)`, "i").test(input.sql))
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
					const existing = yield* sql`SELECT name FROM sqlite_master WHERE type='table'`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))),
					);
					const guarded = protectedTables.filter((table) => existing.some(({ name }) => name.toLowerCase() === table));
					const range = yield* reserve(1);
					// Also protect recovery records reached indirectly through an existing domain trigger.
					// Guard DDL and caller SQL share this transaction, so failures remove both together.
					for (const table of guarded)
						for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
							yield* sql.unsafe(
								`CREATE TEMP TRIGGER comms_sql_guard_${table}_${operation} BEFORE ${operation} ON main.${table} BEGIN SELECT RAISE(ABORT,'reserved SQL bookkeeping'); END`,
							);
						}
					const count = sql`SELECT total_changes() AS count`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ count: Schema.Int })))),
						Effect.map((rows) => rows[0]?.count ?? 0),
					);
					const before = yield* count;
					const raw = yield* sql
						.unsafe<Record<string, unknown>>(input.sql, input.params ?? [])
						.pipe(Effect.provideService(SqlClient.SafeIntegers, true), Effect.mapError(sqlQueryFailure));
					const changes = (yield* count) - before;
					const rows = yield* sqlRows(raw);
					for (const table of guarded)
						for (const operation of ["INSERT", "UPDATE", "DELETE"])
							yield* sql.unsafe(`DROP TRIGGER temp.comms_sql_guard_${table}_${operation}`);
					const outcome = { ...rows, changes, seq: range.from };
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
									changes,
								},
							},
						],
					};
				}),
		});
	});
