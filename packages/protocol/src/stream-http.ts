import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { errorSchemas } from "./errors.ts";
import { RequestValidation } from "./request-validation.ts";
import { QueryCursor, QueryLimit } from "./query-number.ts";
const query = Schema.Struct({
	since: Schema.optionalKey(QueryCursor),
	limit: Schema.optionalKey(QueryLimit),
	topic: Schema.optionalKey(Schema.String),
	types: Schema.optionalKey(Schema.String),
	agent: Schema.optionalKey(Schema.String),
	instance: Schema.optionalKey(Schema.String),
	level: Schema.optionalKey(Schema.String),
});
export const streamGroup = HttpApiGroup.make("stream")
	.add(
		HttpApiEndpoint.get("events", "/api/stream", {
			error: errorSchemas,
			query,
			success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
		}).annotate(
			OpenApi.Description,
			"Tail published events with read scope. Boot http.request records are excluded; read them through authenticated /_boot/events. Filter by topic subtree, types, agent, instance or level. Resume from since or Last-Event-ID; omitted since begins now. Heartbeats every 10 seconds. App replacement closes the stream; reconnect using the last received event id.",
		),
	)
	.middleware(RequestValidation);
