import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { errorSchemas } from "./errors.ts";
import { RequestValidation } from "./request-validation.ts";
export const Me = Schema.Struct({
	agent: Schema.String,
	instance: Schema.String,
	label: Schema.String,
	kind: Schema.Literals(["agent", "human"]),
	scopes: Schema.Array(Schema.String),
	expires_at: Schema.Int,
});
export const profilesGroup = HttpApiGroup.make("profiles")
	.add(
		HttpApiEndpoint.get("me", "/api/me", {
			error: errorSchemas,
			query: Schema.Record(Schema.String, Schema.Never),
			success: HttpApiSchema.WithHeaders(Me, { "cache-control": Schema.Literal("no-store") }),
		}).annotate(
			OpenApi.Description,
			"Read verified caller identity, granted scopes and credential expiry in epoch milliseconds. Requires read. No credential is returned.",
		),
	)
	.middleware(RequestValidation);
