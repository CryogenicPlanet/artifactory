import { DateTime, Effect, Schema } from "effect";
import type { Api, RequestContext } from "../../packages/server/src/kernel/extension-api.ts";

export class TopicDeleteError extends Schema.TaggedError<TopicDeleteError>()("TopicDeleteError", {
	code: Schema.Literals(["input_invalid", "topic_not_found", "author_required"]),
}) {}
const refusals = {
	input_invalid: {
		status: 400,
		message: "Invalid topic deletion request.",
		hint: "Use a valid topic path, no query parameters, and an Idempotency-Key of 1–200 characters when supplied.",
	},
	topic_not_found: {
		status: 404,
		message: "The topic does not exist or is already deleted.",
		hint: "Check the topic path. To recover an uncertain successful deletion, retry with its original Idempotency-Key.",
	},
	author_required: {
		status: 403,
		message: "This instance is not the sole author of the subtree.",
		hint: "Use the instance that authored every retained message, or a human session. Empty and page-only topics require a human.",
	},
} as const satisfies Record<
	TopicDeleteError["code"],
	{ readonly status: number; readonly message: string; readonly hint: string }
>;
const validTopic = (path: string) =>
	path.length <= 200 && /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(path);
export const TopicDeletion = Schema.Struct({ path: Schema.String, deleted_at: Schema.Int, seq: Schema.Int });
const StoredTopic = Schema.Struct({
	meta: Schema.fromJsonString(Schema.JsonObject),
	archived_at: Schema.NullOr(Schema.Int),
	deleted_at: Schema.NullOr(Schema.Int),
});

// Messages holds its mutation permit until the tombstone and its single subtree event publish.
export const deleteTopic = (
	ctx: Pick<RequestContext, "db" | "mutate" | "generation" | "agent" | "instance" | "request" | "kind"> & {
		readonly topics: Pick<RequestContext["topics"], "read">;
	},
	path: string,
	key?: string,
) =>
	Effect.gen(function* () {
		if (!validTopic(path) || (key !== undefined && (key.length < 1 || key.length > 200)))
			return yield* new TopicDeleteError({ code: "input_invalid" });
		const { db: sql, mutate } = ctx;
		const identity = ctx;
		// A separate read cannot deadlock the mutation permit. Its result is needed only for a page-only topic;
		// a retained idempotency receipt replays before entering the mutation body, even after deletion.
		const pageTopic = yield* ctx.topics.read(path).pipe(Effect.result);
		const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({ path, delete: true });
		const now = (yield* DateTime.nowAsDate).getTime();
		return yield* mutate({
			...(key === undefined
				? {}
				: {
						idempotency: {
							instance: identity.instance,
							key,
							kind: "topic.deleted",
							input: encoded,
							outcome: Schema.fromJsonString(TopicDeletion),
						},
					}),
			body: (reserve) =>
				Effect.gen(function* () {
					const deleted =
						yield* sql`SELECT path FROM topics WHERE deleted_at IS NOT NULL AND (path=${path} OR substr(${path},1,length(path)+1)=path||'/') LIMIT 1`;
					if (deleted.length) return yield* new TopicDeleteError({ code: "topic_not_found" });
					const rows = yield* sql`SELECT meta,archived_at,deleted_at FROM topics WHERE path=${path}`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredTopic))),
					);
					const previous = rows[0];
					if (!previous) {
						const descendants =
							yield* sql`SELECT path FROM topics WHERE substr(path,1,length(${path})+1)=${path + "/"} LIMIT 1`;
						if (!descendants.length) {
							if (pageTopic._tag === "Failure") return yield* pageTopic.failure;
						}
					}
					if (identity.kind !== "human") {
						// Deleted messages remain authorship evidence; a sibling instance is a distinct author.
						const authored =
							yield* sql`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN instance<>${identity.instance} THEN 1 ELSE 0 END),0) AS others FROM messages WHERE topic=${path} OR substr(topic,1,length(${path})+1)=${path + "/"}`.pipe(
								Effect.flatMap(
									Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ total: Schema.Int, others: Schema.Int }))),
								),
							);
						if (!authored[0] || authored[0].total === 0 || authored[0].others > 0)
							return yield* new TopicDeleteError({ code: "author_required" });
					}
					const range = yield* reserve(1);
					const outcome = { path, deleted_at: now, seq: range.to };
					// Page-only topics have a published empty metadata image, even without an earlier SQL row.
					const before = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))(
						previous ?? { meta: {}, archived_at: null, deleted_at: null },
					);
					if (previous) {
						yield* sql`UPDATE topics SET deleted_at=${now},updated_seq=${range.to},previous=${before} WHERE path=${path}`;
					} else {
						const parts = path.split("/");
						yield* sql`INSERT INTO topics(path,parent,name,meta,last_seq,created_at,updated_seq,previous,deleted_at) VALUES(${path},${parts.length === 1 ? null : parts.slice(0, -1).join("/")},${parts.at(-1) ?? path},'{}',${range.to},${now},${range.to},${before},${now})`;
					}
					const event = {
						seq: range.to,
						at: now,
						type: "topic.deleted",
						level: "info" as const,
						actor: identity.agent,
						instance: identity.instance,
						generation: ctx.generation,
						request_id: identity.request,
						topic: path,
						message_id: null,
						payload: outcome,
					};
					return { outcome, events: [event] };
				}),
		});
	});

export default function topicDelete(api: Api) {
	api.route("DELETE", "/api/topics/*", {
		description:
			"Tombstone a topic subtree without deleting retained messages or pages. Requires write and sole authorship by this instance, or a human. Empty/page-only topics require a human. Optional Idempotency-Key.",
		scope: "write",
		handler: (request, ctx) =>
			Effect.gen(function* () {
				if (Object.keys(ctx.query).length) return yield* new TopicDeleteError({ code: "input_invalid" });
				const result = yield* deleteTopic(ctx, ctx.params["*"] ?? "", request.headers["idempotency-key"]);
				return Response.json(result, { headers: { "cache-control": "no-store" } });
			}).pipe(
				Effect.catchTag("TopicDeleteError", (error) =>
					Effect.succeed(
						Response.json(
							{
								error: {
									code: error.code,
									message: refusals[error.code].message,
									hint: refusals[error.code].hint,
									retriable: false,
								},
							},
							{ status: refusals[error.code].status },
						),
					),
				),
			),
	});
}
