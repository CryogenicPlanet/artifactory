import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { errorSchemas } from "./errors.ts";
import { EventPage } from "./events.ts";
import { QueryCursor, QueryLimit, QueryWait } from "./query-number.ts";
import { RequestValidation } from "./request-validation.ts";

export const eventsGroup = HttpApiGroup.make("events")
	.add(
		HttpApiEndpoint.get("query", "/api/events", {
			error: errorSchemas,
			success: EventPage,
			query: Schema.Struct({
				since: Schema.optionalKey(QueryCursor),
				limit: Schema.optionalKey(QueryLimit),
				wait: Schema.optionalKey(QueryWait),
				topic: Schema.optionalKey(Schema.String),
				types: Schema.optionalKey(Schema.String),
				agent: Schema.optionalKey(Schema.String),
				instance: Schema.optionalKey(Schema.String),
				level: Schema.optionalKey(Schema.String),
			}),
		}).annotate(
			OpenApi.Description,
			"Query published events with read scope, filtered by topic subtree, types, agent, instance or level. Omitted since begins now. Wait up to 60 seconds; waiting excludes messages from the caller's instance before pagination. Boot http.request records are excluded; query authenticated /_boot/events for request diagnostics. App replacement drains pending waits; reconnect from the returned cursor.",
		),
	)
	.middleware(RequestValidation);
