import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { errorSchemas } from "./errors.ts";
import { RequestValidation } from "./request-validation.ts";
import { TopicMove } from "./topic-move.ts";
import { TopicMetaInput, TopicArchiveInput, TopicMutation } from "./topic-operations.ts";
const query = Schema.Record(Schema.String, Schema.Never);
export const TopicPayload = Schema.Union([
	TopicMetaInput.annotate({ parseOptions: { onExcessProperty: "error" } }),
	TopicArchiveInput.annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export const topicManagementGroup = HttpApiGroup.make("topicManagement")
	.add(
		HttpApiEndpoint.post("move", "/api/topics/:path/move", {
			params: { path: Schema.String },
			headers: { "idempotency-key": Schema.optionalKey(Schema.String) },
			error: errorSchemas,
			query,
			payload: Schema.Struct({ to: Schema.String }),
			success: TopicMove,
		}).annotate(
			OpenApi.Description,
			"POST /api/topics/<path>/move with {to}. Requires write. Move a topic subtree to an absent destination; Idempotency-Key preserves the first outcome.",
		),
		HttpApiEndpoint.put("meta", "/api/topics/:path", {
			params: { path: Schema.String },
			headers: { "idempotency-key": Schema.optionalKey(Schema.String) },
			error: errorSchemas,
			query,
			payload: TopicPayload,
			success: TopicMutation,
		}).annotate(
			OpenApi.Description,
			"Replace metadata with {meta}, creating missing ancestors, or set {archived:true|false}. Requires write. Archived subtrees remain readable. Success follows durable topic publication; Idempotency-Key preserves the first outcome.",
		),
		HttpApiEndpoint.post("legacyMove", "/api/topics/*", {
			headers: { "idempotency-key": Schema.optionalKey(Schema.String) },
			error: errorSchemas,
			query,
			payload: Schema.Struct({ to: Schema.String }),
			success: TopicMove,
		}).annotate(
			OpenApi.Description,
			"POST /api/topics/<path>/move with {to}. Requires write. Move a topic subtree to an absent destination; Idempotency-Key preserves the first outcome.",
		),
		HttpApiEndpoint.put("legacyMeta", "/api/topics/*", {
			headers: { "idempotency-key": Schema.optionalKey(Schema.String) },
			error: errorSchemas,
			query,
			payload: TopicPayload,
			success: TopicMutation,
		}).annotate(
			OpenApi.Description,
			"Replace metadata with {meta}, creating missing ancestors, or set {archived:true|false}. Requires write. Archived subtrees remain readable. Success follows durable topic publication; Idempotency-Key preserves the first outcome.",
		),
	)
	.middleware(RequestValidation);
