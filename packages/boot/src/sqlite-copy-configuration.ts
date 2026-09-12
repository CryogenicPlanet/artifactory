import { Schema } from "effect";

/** Fixed immutable copy operation; no command, module or credential is supplied. */
export const SqliteCopyConfiguration = Schema.Struct({
	attempt: Schema.String,
	source: Schema.String,
	destination: Schema.String,
	receipt: Schema.String,
	budgetMs: Schema.Number,
});
export const SqliteCopyReceipt = Schema.Struct({
	attempt: Schema.String,
	source: Schema.String,
	destination: Schema.String,
	outcome: Schema.Literals(["completed", "failed", "timeout"]),
});
export const SqliteCopyIntent = Schema.Struct({
	...SqliteCopyConfiguration.fields,
	boot_id: Schema.NullOr(Schema.String),
});
