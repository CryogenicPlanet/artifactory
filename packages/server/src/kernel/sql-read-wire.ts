import { Schema } from "effect";
import { ErrorEnvelope } from "@comms/protocol/errors";
import { SqlInput } from "./sql-input.ts";
import { SqlRows } from "./sql-result.ts";

export const ReadRequest = Schema.Struct({
	filename: Schema.String,
	allowRead: Schema.Boolean,
	input: SqlInput,
});
export const ReadResult = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("write") }),
	Schema.Struct({ kind: Schema.Literal("read"), result: SqlRows }),
]);
export const ReadResponse = Schema.Union([ReadResult, ErrorEnvelope]);
