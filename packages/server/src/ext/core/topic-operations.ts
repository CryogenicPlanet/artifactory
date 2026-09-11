import { DateTime, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type BootChannel, type EventRecord, KernelError } from "../../kernel/boot-channel.ts";
import type { Mutate } from "../../kernel/mutate.ts";
import { validTopic } from "./messages.ts";
import type { Identity } from "../../kernel/identity.ts";

export const TopicMetaInput = Schema.Struct({ meta: Schema.JsonObject });
export const TopicArchiveInput = Schema.Struct({ archived: Schema.Boolean });
export const TopicMutation = Schema.Struct({
	path: Schema.String,
	meta: Schema.JsonObject,
	archived_at: Schema.NullOr(Schema.Int),
	seq: Schema.Int,
});
const StoredTopic = Schema.Struct({
	deleted_at: Schema.NullOr(Schema.Int),
	path: Schema.String,
	meta: Schema.fromJsonString(Schema.JsonObject),
	archived_at: Schema.NullOr(Schema.Int),
	updated_seq: Schema.Int,
});

// The caller holds Messages' permit through commit and immediate publication.
export const mutateTopic = (
	sql: SqlClient,
	mutate: Mutate,
	boot: Pick<BootChannel["Service"], "generation">,
	identity: Identity,
	path: string,
	input: typeof TopicMetaInput.Type | typeof TopicArchiveInput.Type,
	key?: string,
) =>
	Effect.gen(function* () {
		if (!validTopic(path) || (key !== undefined && (key.length < 1 || key.length > 200)))
			return yield* new KernelError({ code: "input_invalid" });
		const archive = "archived" in input;
		const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({ path, input });
		if (Buffer.byteLength(encoded) > 131072) return yield* new KernelError({ code: "input_invalid" });
		const now = (yield* DateTime.nowAsDate).getTime();
		return yield* mutate({
			...(key === undefined
				? {}
				: {
						idempotency: {
							instance: identity.instance,
							key,
							kind: archive ? "topic.archived" : "topic.meta",
							input: encoded,
							outcome: Schema.fromJsonString(TopicMutation),
						},
					}),
			body: (reserve) =>
				Effect.gen(function* () {
					const deleted =
						yield* sql`SELECT path FROM topics WHERE deleted_at IS NOT NULL AND (path=${path} OR substr(${path},1,length(path)+1)=path||'/') LIMIT 1`;
					if (deleted.length) return yield* new KernelError({ code: "topic_not_found" });
					const rows =
						yield* sql`SELECT path,meta,archived_at,deleted_at,updated_seq FROM topics WHERE path=${path}`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredTopic))),
						);
					const previous = rows[0];
					if (archive && !previous) return yield* new KernelError({ code: "topic_not_found" });
					const archived =
						yield* sql`SELECT path FROM topics WHERE archived_at IS NOT NULL AND (path=${path} OR substr(${path},1,length(path)+1)=path||'/') AND (${archive ? 1 : 0}=0 OR path<>${path}) LIMIT 1`;
					if (archived.length) return yield* new KernelError({ code: "topic_archived" });
					const parts = path.split("/");
					const missing: Array<{ path: string; parent: string | null; name: string }> = [];
					for (let i = 0; i < parts.length; i++) {
						const ancestor = parts.slice(0, i + 1).join("/");
						if ((yield* sql`SELECT path FROM topics WHERE path=${ancestor}`).length === 0)
							missing.push({
								path: ancestor,
								parent: i === 0 ? null : parts.slice(0, i).join("/"),
								name: parts[i] ?? "",
							});
					}
					const range = yield* reserve(missing.length + 1);
					const event = (seq: number, type: string, topic: string, payload: Schema.JsonObject) => ({
						seq,
						at: now,
						type,
						level: "info" as const,
						actor: identity.agent,
						instance: identity.instance,
						generation: boot.generation,
						request_id: identity.request,
						topic,
						message_id: null,
						payload,
					});
					const records: Array<typeof EventRecord.Type> = [];
					for (const [index, topic] of missing.entries()) {
						const seq = range.from + index;
						yield* sql`INSERT INTO topics(path,parent,name,meta,last_seq,created_at,updated_seq) VALUES(${topic.path},${topic.parent},${topic.name},'{}',${seq},${now},${seq})`;
						records.push(event(seq, "topic.created", topic.path, topic));
					}
					const outcome = {
						path,
						meta: "meta" in input ? input.meta : (previous?.meta ?? {}),
						archived_at:
							"archived" in input
								? input.archived
									? (previous?.archived_at ?? now)
									: null
								: (previous?.archived_at ?? null),
						seq: range.to,
					};
					const before = previous
						? yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
								meta: previous.meta,
								archived_at: previous.archived_at,
								deleted_at: previous.deleted_at,
							})
						: null;
					const meta = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))(outcome.meta);
					yield* sql`UPDATE topics SET meta=${meta},archived_at=${outcome.archived_at},updated_seq=${range.to},previous=${before} WHERE path=${path}`;
					records.push(event(range.to, archive ? "topic.archived" : "topic.meta", path, outcome));
					return { outcome, events: records };
				}),
		});
	});
