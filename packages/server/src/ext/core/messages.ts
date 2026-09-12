import { isDescendant, jsonArrayHas, nullable } from "@comms/storage/dialect";
import { Message, MessageInput } from "@comms/protocol/messages";
import { Publication } from "../../kernel/publication.ts";
import type { Identity } from "../../kernel/identity.ts";
import type { PageMoveIO } from "./topic-page-continuation.ts";
import { Context, Crypto, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type EventRecord } from "@comms/protocol/events";
import { BootChannel, KernelError } from "../../kernel/boot-channel.ts";
import { type TopicMetaInput, type TopicArchiveInput } from "@comms/protocol/topic-operations";
import { mutateTopic } from "./topic-operations.ts";
import { type MessagePatch } from "@comms/protocol/message-patch";
import { mutateMessage } from "./message-operations.ts";
import { publishedMessages } from "./published-messages.ts";
import { markRead } from "./read-marks.ts";
import { moveTopic } from "./topic-move.ts";
import { mentionsIn } from "./message-mentions.ts";

export const StoredMessage = Schema.Struct({
	...Message.fields,
	tags: Schema.fromJsonString(Schema.Array(Schema.String)),
	meta: Schema.fromJsonString(Schema.JsonObject),
});
export const validTopic = (topic: string) =>
	topic.length <= 200 && /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(topic);
const messageRows = Schema.decodeUnknownEffect(Schema.Array(StoredMessage));
const jsonObject = Schema.encodeSync(Schema.fromJsonString(Schema.JsonObject));
/** Core domain operations consume the same SQL/read/mutation capabilities exposed to extensions. */
export const makeMessages = (
	sql: SqlClient.SqlClient,
	publication: Pick<Publication["Service"], "mutate" | "read">,
	boot: Pick<BootChannel["Service"], "generation">,
	crypto: Crypto.Crypto,
) => {
	const { mutate, read } = publication;
	const create = (identity: Identity, input: typeof MessageInput.Type, key?: string) =>
		Effect.gen(function* () {
			if (
				!validTopic(input.topic) ||
				input.body.length === 0 ||
				input.body.length > 65536 ||
				input.tags?.some((tag) => tag.length > 100) ||
				(input.tags?.length ?? 0) > 100 ||
				(key !== undefined && (key.length < 1 || key.length > 200))
			)
				return yield* new KernelError({ code: "input_invalid" });
			const id = `m_${Buffer.from(yield* crypto.randomBytes(12)).toString("hex")}`;
			const now = (yield* DateTime.nowAsDate).getTime();
			const normalized = { topic: input.topic, body: input.body, tags: input.tags ?? [], meta: input.meta ?? {} };
			const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(MessageInput))(normalized);

			return yield* mutate({
				...(key === undefined
					? {}
					: {
							idempotency: {
								instance: identity.instance,
								key,
								kind: "message.created",
								input: encoded,
								outcome: Schema.fromJsonString(Message),
							},
						}),
				body: (reserve) =>
					Effect.gen(function* () {
						if (new TextEncoder().encode(encoded).byteLength > 131072)
							return yield* new KernelError({ code: "input_invalid" });
						const deleted =
							yield* sql`SELECT path FROM topics WHERE deleted_at IS NOT NULL AND (path=${input.topic} OR ${isDescendant(sql, input.topic, sql("path"))}) LIMIT 1`;
						if (deleted.length > 0) return yield* new KernelError({ code: "topic_not_found" });
						const archived =
							yield* sql`SELECT path FROM topics WHERE archived_at IS NOT NULL AND (path=${input.topic} OR ${isDescendant(sql, input.topic, sql("path"))}) LIMIT 1`;
						if (archived.length > 0) return yield* new KernelError({ code: "topic_archived" });
						const parts = input.topic.split("/");
						const missing: Array<{ path: string; parent: string | null; name: string }> = [];
						for (let i = 0; i < parts.length; i++) {
							const path = parts.slice(0, i + 1).join("/");
							if ((yield* sql`SELECT path FROM topics WHERE path=${path}`).length === 0)
								missing.push({ path, parent: i === 0 ? null : parts.slice(0, i).join("/"), name: parts[i] ?? "" });
						}
						const range = yield* reserve(missing.length + 1);
						const records: Array<typeof EventRecord.Type> = [];
						for (const [index, topic] of missing.entries()) {
							const seq = range.from + index;
							yield* sql`INSERT INTO topics(path,parent,name,meta,last_seq,created_at,updated_seq) VALUES(${topic.path},${topic.parent},${topic.name},'{}',${seq},${now},${seq})`;
							records.push({
								seq,
								at: now,
								type: "topic.created",
								level: "info",
								actor: identity.agent,
								instance: identity.instance,
								generation: boot.generation,
								request_id: identity.request,
								topic: topic.path,
								message_id: null,
								payload: topic,
							});
						}
						const message = {
							id,
							seq: range.to,
							...normalized,
							agent: identity.agent,
							instance: identity.instance,
							created_at: now,
							edited_at: null,
							deleted_at: null,
						};
						const tagsJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
							normalized.tags,
						);
						yield* sql`INSERT INTO messages(id,seq,topic,agent,instance,body,tags,meta,created_at,mentions) VALUES(${id},${range.to},${input.topic},${identity.agent},${identity.instance},${input.body},${tagsJson},${jsonObject(normalized.meta)},${now},${JSON.stringify(mentionsIn(input.body))})`;
						for (let i = 0; i < parts.length; i++)
							yield* sql`UPDATE topics SET last_seq=${range.to} WHERE path=${parts.slice(0, i + 1).join("/")}`;
						records.push({
							seq: range.to,
							at: now,
							type: "message.created",
							level: "info",
							actor: identity.agent,
							instance: identity.instance,
							generation: boot.generation,
							request_id: identity.request,
							topic: input.topic,
							message_id: id,
							payload: message,
						});
						return { outcome: message, events: records };
					}),
			});
		});
	const list = (input: {
		readonly since?: number;
		readonly topic?: string;
		readonly recursive?: boolean;
		readonly limit: number;
		readonly exclude?: string;
		readonly newest?: boolean;
		readonly tag?: string;
		readonly agent?: string;
		readonly q?: string;
		readonly mentions?: ReadonlyArray<string>;
	}) =>
		read((ceiling) =>
			Effect.gen(function* () {
				const since = input.since ?? (input.newest ? 0 : ceiling);
				if (
					!Number.isSafeInteger(since) ||
					since < 0 ||
					!Number.isSafeInteger(input.limit) ||
					input.limit < 1 ||
					input.limit > 200 ||
					(input.topic !== undefined && !validTopic(input.topic))
				)
					return yield* new KernelError({ code: "query_invalid" });
				if (since > ceiling) return yield* new KernelError({ code: "cursor_ahead" });
				if (
					(input.tag !== undefined && input.tag.length > 100) ||
					(input.agent !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.agent))
				)
					return yield* new KernelError({ code: "query_invalid" });
				const targets = input.mentions ?? [];
				if (targets.length > 32 || targets.some((target) => !target.startsWith("@") || !validTopic(target)))
					return yield* new KernelError({ code: "query_invalid" });
				const topicMatch = sql`(topic=${input.topic ?? null} OR ${input.recursive ? 1 : 0}=1 AND ${isDescendant(sql, sql("topic"), input.topic ?? "")})`;
				const mentions = sql`CASE WHEN mention_source.updated_seq>${ceiling} THEN mention_source.previous_mentions ELSE mention_source.mentions END`;
				const mentionMatch =
					targets.length === 0
						? sql`1=0`
						: sql`EXISTS (SELECT 1 FROM messages mention_source WHERE mention_source.id=visible_messages.id AND ${sql.or(targets.map((target) => jsonArrayHas(sql, mentions, target)))})`;
				let bodyMatch = sql`1=1`;
				if (input.q !== undefined) {
					// Quote every term: caller text must never become SQL or FTS syntax.
					const parts = input.q.trim().match(/"[^"]*"|[^\s"]+/gu) ?? [];
					if (
						input.q.length > 512 ||
						input.q.includes("\0") ||
						parts.length === 0 ||
						parts.length > 16 ||
						input.q.replace(/"[^"]*"|[^\s"]+|\s+/gu, "") !== "" ||
						parts.some((part) => !/[\p{L}\p{N}]/u.test(part))
					)
						return yield* new KernelError({ code: "query_invalid" });
					const expression = parts.map((part) => `"${part.replaceAll('"', "")}"`).join(" AND ");
					// Both index columns share this SQL snapshot; select the published image's column.
					bodyMatch = sql`id IN (
     SELECT message_id FROM messages_fts JOIN messages ON messages.id=messages_fts.message_id
      WHERE messages_fts MATCH ${`body : (${expression})`} AND messages.updated_seq<=${ceiling}
     UNION
     SELECT message_id FROM messages_fts JOIN messages ON messages.id=messages_fts.message_id
      WHERE messages_fts MATCH ${`previous_body : (${expression})`} AND messages.updated_seq>${ceiling}
    )`;
				}
				const items =
					yield* sql`WITH visible_messages AS (${publishedMessages(sql, ceiling)}) SELECT * FROM visible_messages WHERE deleted_at IS NULL AND seq>${since} AND seq<=${ceiling}
   AND ((${input.topic === undefined && targets.length === 0 ? 1 : 0}=1) OR ${topicMatch} OR ${mentionMatch})
   AND (${nullable(sql, input.exclude ?? null)} IS NULL OR instance<>${input.exclude ?? null})
   AND (${nullable(sql, input.agent ?? null)} IS NULL OR agent=${input.agent ?? null})
   AND (${nullable(sql, input.tag ?? null)} IS NULL OR ${jsonArrayHas(sql, sql("visible_messages.tags"), input.tag ?? null)})
   AND ${bodyMatch}
   ORDER BY CASE WHEN ${input.newest ? 1 : 0}=1 THEN -seq ELSE seq END LIMIT ${input.limit + 1}`.pipe(
						Effect.flatMap(messageRows),
					);
				const page = items.slice(0, input.limit);
				const cursor = input.newest || items.length <= input.limit ? ceiling : (page.at(-1)?.seq ?? since);
				return { items: input.newest ? page.reverse() : page, cursor, timed_out: false, drained: false };
			}),
		);
	const get = (id: string) =>
		read((ceiling) =>
			Effect.gen(function* () {
				const rows =
					yield* sql`WITH visible_messages AS (${publishedMessages(sql, ceiling)}) SELECT * FROM visible_messages WHERE id=${id} AND deleted_at IS NULL`.pipe(
						Effect.flatMap(messageRows),
					);
				if (!rows[0]) return yield* new KernelError({ code: "message_not_found" });
				return rows[0];
			}),
		);
	return {
		create,
		moveTopic: (identity: Identity, from: string, to: string, pages: PageMoveIO, key?: string) =>
			moveTopic(sql, mutate, boot, identity, from, to, pages, key),
		read,
		topic: (
			identity: Identity,
			path: string,
			input: typeof TopicMetaInput.Type | typeof TopicArchiveInput.Type,
			key?: string,
		) => mutateTopic(sql, mutate, boot, identity, path, input, key),
		get,
		update: (identity: Identity, id: string, input: typeof MessagePatch.Type, key?: string) =>
			mutateMessage(sql, mutate, boot, identity, id, input, key),
		remove: (identity: Identity, id: string, key?: string) => mutateMessage(sql, mutate, boot, identity, id, null, key),
		list,
		mark: (identity: Identity, input: { readonly topic: string; readonly seq: number }) =>
			markRead(sql, mutate, identity, input),
	};
};
const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const boot = yield* BootChannel;
	const crypto = yield* Crypto.Crypto;
	const publication = yield* Publication;
	return { ...publication, ...makeMessages(sql, publication, boot, crypto) };
});
export class Messages extends Context.Service<Messages, Effect.Success<typeof make>>()("comms/server/Messages") {}
export const layer = Layer.effect(Messages, make);
