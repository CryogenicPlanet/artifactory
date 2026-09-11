import { DateTime, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type BootChannel, KernelError } from "./boot-channel.ts";
import type { Mutate } from "./mutate.ts";
import { type Identity, validTopic } from "./messages.ts";
import { Pages } from "./pages.ts";

export const TopicDeletion = Schema.Struct({ path: Schema.String, deleted_at: Schema.Int, seq: Schema.Int });
const StoredTopic = Schema.Struct({
	meta: Schema.fromJsonString(Schema.JsonObject),
	archived_at: Schema.NullOr(Schema.Int),
	deleted_at: Schema.NullOr(Schema.Int),
});

// Messages holds its mutation permit until the tombstone and its single subtree event publish.
export const deleteTopic = (
	sql: SqlClient,
	mutate: Mutate,
	boot: BootChannel["Service"],
	identity: Identity,
	path: string,
	key?: string,
) =>
	Effect.gen(function* () {
		if (!validTopic(path) || (key !== undefined && (key.length < 1 || key.length > 200)))
			return yield* new KernelError({ code: "input_invalid" });
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
					if (deleted.length) return yield* new KernelError({ code: "topic_not_found" });
					const rows = yield* sql`SELECT meta,archived_at,deleted_at FROM topics WHERE path=${path}`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredTopic))),
					);
					const previous = rows[0];
					if (!previous) {
						const descendants =
							yield* sql`SELECT path FROM topics WHERE substr(path,1,length(${path})+1)=${path + "/"} LIMIT 1`;
						if (!descendants.length) {
							const pages = Option.getOrNull(yield* Effect.serviceOption(Pages));
							if (!pages || !(yield* pages.topic(path)).exists)
								return yield* new KernelError({ code: "topic_not_found" });
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
							return yield* new KernelError({ code: "author_required" });
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
						generation: boot.generation,
						request_id: identity.request,
						topic: path,
						message_id: null,
						payload: outcome,
					};
					return { outcome, events: [event] };
				}),
		});
	});
