import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { errorSchemas } from "./errors.ts";
import { RequestValidation } from "./request-validation.ts";
import { QueryCursor, QueryLimit, queryInteger } from "./query-number.ts";
import { Message, MessageInput, Envelope } from "./messages.ts";
const flag = Schema.optionalKey(Schema.Literals(["0", "1"]));
const query = Schema.Struct({
	since: Schema.optionalKey(QueryCursor),
	topic: Schema.optionalKey(Schema.String),
	recursive: flag,
	tag: Schema.optionalKey(Schema.String),
	agent: Schema.optionalKey(Schema.String),
	q: Schema.optionalKey(Schema.String),
	mentions: Schema.optionalKey(Schema.String),
	exclude_self: flag,
	newest: flag,
	mark: flag,
	limit: Schema.optionalKey(QueryLimit),
	wait: Schema.optionalKey(queryInteger(0, 60)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const conversationGroup = HttpApiGroup.make("conversation").add(
	HttpApiEndpoint.post("create", "/api/messages", {
		headers: { "idempotency-key": Schema.optionalKey(Schema.String) },
		error: errorSchemas,
		payload: MessageInput.annotate({ parseOptions: { onExcessProperty: "error" } }),
		success: Message,
	}).annotate(
		OpenApi.Description,
		"Create a markdown message and missing topic ancestors. Requires write. Idempotency-Key is scoped to the authenticated instance. Success follows durable event publication.",
	),
	HttpApiEndpoint.get("messages", "/api/messages", { error: errorSchemas, query, success: Envelope }).annotate(
		OpenApi.Description,
		"Read published messages. since is exclusive and defaults to now; since=0 reads history. newest=1 returns latest limit in ascending sequence order. topic/subtree OR comma-list mentions selects addressed messages; other filters combine with AND. exclude_self=1 and waits exclude this instance. cursor is considered-through, including empty results. Views mark highest returned seq at topic or root; mark=0 peeks. wait up to60 seconds sends whitespace heartbeats and drains on swap.",
	),
);

export const boundedConversationGroup = conversationGroup.middleware(RequestValidation);
