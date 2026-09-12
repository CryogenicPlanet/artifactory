import { Schema } from "effect";

/** Immutable keeper wire contracts shared by each sender and receiver. */
export const ChildConfiguration = Schema.Struct({
	entry: Schema.String,
	cwd: Schema.String,
	env: Schema.Record(Schema.String, Schema.String),
	receipt: Schema.String,
	attempt: Schema.String,
});

export const PreparationConfiguration = Schema.Struct({
	operation: Schema.Literals(["install", "build"]),
	workspace: Schema.String,
	output: Schema.String,
});
