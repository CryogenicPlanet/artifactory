import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { errorSchemas } from "./errors.ts";
export const ExtensionStatus = Schema.Struct({
	name: Schema.String,
	status: Schema.Literals(["loaded", "disabled"]),
	load_ms: Schema.Finite,
	error: Schema.NullOr(Schema.String),
	events: Schema.Array(Schema.String),
	cron: Schema.Array(Schema.String),
	registrations: Schema.Array(
		Schema.Struct({ method: Schema.String, path: Schema.String, description: Schema.String, scope: Schema.String }),
	),
});
export const extGroup = HttpApiGroup.make("ext").add(
	HttpApiEndpoint.get("list", "/api/ext", { success: Schema.Array(ExtensionStatus), error: errorSchemas }).annotate(
		OpenApi.Description,
		"List loaded extensions, registrations and failures. Requires read.",
	),
);
