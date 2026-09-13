import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { errorSchemas } from "./errors.ts";
import { RequestValidation } from "./request-validation.ts";
import { QueryDepth } from "./query-number.ts";
import { TopicResult } from "./topics.ts";
export const TopicQuery = Schema.Struct({
	depth: Schema.optionalKey(QueryDepth),
	archived: Schema.optionalKey(Schema.Literals(["0", "1"])),
	mark: Schema.optionalKey(Schema.Literals(["0", "1"])),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
// Typed aliases serve generated clients internally. Keep outer extension ownership and discovery
// on the original wildcard so a later wildcard override also owns encoded and single-segment paths.
export const topicsGroup = HttpApiGroup.make("topics")
	.add(
		HttpApiEndpoint.get("detail", "/api/topics/:path", {
			params: { path: Schema.String },
			error: errorSchemas,
			query: TopicQuery,
			success: TopicResult,
		})
			.annotate(
				OpenApi.Description,
				"Read a topic, subtopics, latest 100 messages and pages. GET /api/topics is the root alias. Requires read. The snapshot fence is not a pagination cursor. Non-root views mark the highest returned message sequence; the root view never marks reads. mark=0 peeks. Archived children require archived=1, and archived_root names the ancestor whose archival applies.",
			)
			.annotate(OpenApi.Exclude, true),

		HttpApiEndpoint.get("legacyDetail", "/api/topics/*", {
			error: errorSchemas,
			query: TopicQuery,
			success: TopicResult,
		})
			.annotate(
				OpenApi.Description,
				"Read a topic, subtopics, latest 100 messages and pages. GET /api/topics is the root alias. Requires read. The snapshot fence is not a pagination cursor. Non-root views mark the highest returned message sequence; the root view never marks reads. mark=0 peeks. Archived children require archived=1, and archived_root names the ancestor whose archival applies.",
			)
			.annotate(OpenApi.Identifier, "topics.detail"),
	)
	.middleware(RequestValidation);

// HttpRouter already registers the wildcard at its base. Only the client needs an explicit root alias.
export const rootTopic = HttpApiEndpoint.get("root", "/api/topics", {
	error: errorSchemas,
	query: TopicQuery,
	success: TopicResult,
})
	.annotate(
		OpenApi.Description,
		"Read a topic, subtopics, latest 100 messages and pages. GET /api/topics is the root alias. Requires read. The snapshot fence is not a pagination cursor. Non-root views mark the highest returned message sequence; the root view never marks reads. mark=0 peeks. Archived children require archived=1, and archived_root names the ancestor whose archival applies.",
	)
	.annotate(OpenApi.Exclude, true);
