import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { BootChannel, KernelError } from "./boot-channel.ts";
import { sqlRows } from "./sql-result.ts";

export const SqlInput = Schema.Struct({
	sql: Schema.String,
	params: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Finite, Schema.Null]))),
});
export const sqlInput = (input: typeof SqlInput.Type) =>
	Effect.gen(function* () {
		if (
			input.sql.trim().length === 0 ||
			new TextEncoder().encode(input.sql).byteLength > 16384 ||
			(input.params?.length ?? 0) > 100 ||
			input.params?.some(
				(value) =>
					typeof value === "number" &&
					(!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))),
			)
		)
			return yield* new KernelError({ code: "input_invalid" });
		// No parser: separators, comments and NUL are deliberately unsupported, including inside SQL literals.
		if (/;|--|\/\*|\*\/|\0/.test(input.sql)) return yield* new KernelError({ code: "sql_unsupported" });
	});

// SQLite compilation errors identify an unsupported query shape; unavailable stores must stay retriable.
const compilationError = Schema.is(Schema.Struct({ code: Schema.Literal("SQLITE_ERROR") }));
const statementError = Schema.is(
	Schema.Struct({ code: Schema.Literals(["SQLITE_ERROR", "SQLITE_RANGE", "SQLITE_MISMATCH", "SQLITE_TOOBIG"]) }),
);
const nativeMessage = Schema.is(Schema.Struct({ message: Schema.String }));
const bindingError = (cause: unknown) =>
	nativeMessage(cause) && /^SQLite query expected \d+ values, received \d+$/.test(cause.message);
export const sqlQueryFailure = (error: SqlError) =>
	bindingError(error.reason.cause) ||
	statementError(error.reason.cause) ||
	["ConstraintError", "UniqueViolation"].includes(error.reason._tag)
		? new KernelError({ code: "sql_query_invalid" })
		: error;

/** Let SQLite compile the SELECT wrapper; do not depend on its internal EXPLAIN opcodes. */
export const queryShape = (input: typeof SqlInput.Type) =>
	Effect.gen(function* () {
		yield* sqlInput(input);
		if (/^SELECT\b/i.test(input.sql.trim())) return true;
		if (!/^WITH\b/i.test(input.sql.trim())) return false;
		const boot = yield* BootChannel;
		return yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* sql.unsafe(`EXPLAIN SELECT * FROM (${input.sql}\n) LIMIT 201`, input.params ?? []).pipe(
				Effect.as(true),
				Effect.catchIf(
					(error) => compilationError(error.reason.cause),
					// Do not compile the write here: retained results must replay even if a
					// later schema repair removed the statement's original target.
					() => Effect.succeed(false),
				),
				Effect.mapError(sqlQueryFailure),
			);
		}).pipe(
			Effect.provide(
				SqliteClient.layer({ filename: boot.filename, readonly: true, disableWAL: true, busyTimeout: "100 millis" }),
			),
		);
	});
/** Physical committed-row inspection; deliberately does not promise a publication cursor. */
export const readSql = (input: typeof SqlInput.Type) =>
	Effect.gen(function* () {
		yield* sqlInput(input);
		const boot = yield* BootChannel;
		return yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql
				.unsafe<Record<string, unknown>>(`SELECT * FROM (${input.sql}\n) LIMIT 201`, input.params ?? [])
				.pipe(Effect.provideService(SqlClient.SafeIntegers, true), Effect.mapError(sqlQueryFailure));
			return yield* sqlRows(rows);
		}).pipe(
			Effect.provide(
				SqliteClient.layer({ filename: boot.filename, readonly: true, disableWAL: true, busyTimeout: "100 millis" }),
			),
		);
	});
