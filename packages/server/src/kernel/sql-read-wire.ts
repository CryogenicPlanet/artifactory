import { Schema } from "effect";
import { ErrorEnvelope } from "@comms/protocol/errors";
import { SqlInput } from "./sql-input.ts";
import { SqlRows } from "./sql-result.ts";

export const ReadRequest = Schema.Struct({
	store: Schema.String,
	allowRead: Schema.Boolean,
	input: SqlInput,
});
export const SqlReadRows = Schema.Struct({ ...SqlRows.fields, dialect: Schema.Literals(["sqlite", "pg", "mysql"]) });
export const ReadResult = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("write") }),
	Schema.Struct({ kind: Schema.Literal("read"), result: SqlReadRows }),
]);
export const ReadResponse = Schema.Union([ReadResult, ErrorEnvelope]);
