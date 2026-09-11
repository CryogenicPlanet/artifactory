import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { KernelError } from "./boot-channel.ts";

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
