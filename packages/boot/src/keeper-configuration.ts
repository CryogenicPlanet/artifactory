import { Schema } from "effect";

export const RemoteChildConfiguration = Schema.Struct({
	root: Schema.String,
	dataDirectory: Schema.String,
	bootStore: Schema.String,
	tls: Schema.Boolean,
});

/** Immutable keeper wire contracts shared by each sender and receiver. */
export const ChildConfiguration = Schema.Struct({
	entry: Schema.String,
	cwd: Schema.String,
	env: Schema.Record(Schema.String, Schema.String),
	receipt: Schema.String,
	attempt: Schema.String,
	remote: Schema.optionalKey(RemoteChildConfiguration),
});

export const PreparationConfiguration = Schema.Struct({
	operation: Schema.Literals(["install", "build"]),
	workspace: Schema.String,
	output: Schema.String,
});
