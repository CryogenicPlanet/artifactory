import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { errorSchemas } from "./errors.ts";
import { RequestValidation } from "./request-validation.ts";
import { queryInteger } from "./query-number.ts";
import { TopicResult } from "./topics.ts";
export const TopicQuery = Schema.Struct({
	depth: Schema.optionalKey(queryInteger(1, 200)),
	archived: Schema.optionalKey(Schema.Literals(["0", "1"])),
	mark: Schema.optionalKey(Schema.Literals(["0", "1"])),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export const topicsGroup = HttpApiGroup.make("topics")
	.add(
		HttpApiEndpoint.get("detail", "/api/topics/:path", {
			params: { path: Schema.String },
			error: errorSchemas,
			query: TopicQuery,
			success: TopicResult,
		}).annotate(
			OpenApi.Description,
			"Read a topic, subtopics, latest 100 messages and pages. GET /api/topics is the root alias. Requires read. The snapshot fence is not a pagination cursor. Views mark the highest returned message sequence; mark=0 peeks. Archived children require archived=1.",
		),
		HttpApiEndpoint.get("root", "/api/topics", {
			error: errorSchemas,
			query: TopicQuery,
			success: TopicResult,
		}).annotate(
			OpenApi.Description,
			"Read a topic, subtopics, latest 100 messages and pages. GET /api/topics is the root alias. Requires read. The snapshot fence is not a pagination cursor. Views mark the highest returned message sequence; mark=0 peeks. Archived children require archived=1.",
		),
		HttpApiEndpoint.get("legacyDetail", "/api/topics/*", {
			error: errorSchemas,
			query: TopicQuery,
			success: TopicResult,
		}).annotate(
			OpenApi.Description,
			"Read a topic, subtopics, latest 100 messages and pages. GET /api/topics is the root alias. Requires read. The snapshot fence is not a pagination cursor. Views mark the highest returned message sequence; mark=0 peeks. Archived children require archived=1.",
		),
	)
	.middleware(RequestValidation);
