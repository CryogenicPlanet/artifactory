import { Schema } from "effect";
import { RemoteChildConfiguration } from "./keeper-configuration.ts";

/** Credentials travel only through the private keeper environment, never command arguments or errors. */
export const NativeCopyConfiguration = Schema.Struct({
	id: Schema.String,
	store: Schema.String,
	remote: RemoteChildConfiguration,
	operation: Schema.Literals(["dump", "load"]),
	path: Schema.String,
	engine: Schema.Literals(["pg", "mysql"]),
	budgetMs: Schema.Number,
	ownership: Schema.Literals(["preserve", "current-role"]),
});
export const NativeCopyReceipt = Schema.Struct({
	attempt: Schema.String,
	root: Schema.String,
	state: Schema.Literal("closed"),
	scope: Schema.Literal("account"),
});
export class NativeCopyRejected extends Schema.TaggedError<NativeCopyRejected>()("NativeCopyRejected", {
	code: Schema.Literals(["native_copy_invalid", "native_copy_failed", "native_copy_closure_unproven"]),
}) {}
