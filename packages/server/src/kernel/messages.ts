import { Context, Crypto, DateTime, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, type Batch, EventRecord, KernelError } from "./boot-channel.ts";
import { mutateTopic, type TopicMetaInput, type TopicArchiveInput } from "./topic-operations.ts";
import { mutateMessage, type MessagePatch } from "./message-operations.ts";
import { toggleReaction, listReactions, type ReactionInput } from "./reaction-operations.ts";
import { publishedMessages } from "./published-messages.ts";
import { HealthProbe } from "./health-probe.ts";
import { markRead } from "./read-marks.ts";
import { recordOperationalEvent, type OperationalEvent } from "./operational-events.ts";
import { deleteTopic } from "./topic-delete.ts";
import { moveTopic, type TopicMoveCommand } from "./topic-move.ts";
import { writerGate } from "./database.ts";

export const Message = Schema.Struct({
	id: Schema.String,
	seq: Schema.Int,
	topic: Schema.String,
	agent: Schema.String,
	instance: Schema.String,
	body: Schema.String,
	tags: Schema.Array(Schema.String),
	meta: Schema.JsonObject,
	created_at: Schema.Int,
	edited_at: Schema.NullOr(Schema.Int),
	deleted_at: Schema.NullOr(Schema.Int),
});
export const Envelope = Schema.Struct({
	items: Schema.Array(Message),
	cursor: Schema.Int,
	timed_out: Schema.Boolean,
	drained: Schema.Boolean,
});
export const MessageInput = Schema.Struct({
	topic: Schema.String,
	body: Schema.String,
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	meta: Schema.optionalKey(Schema.JsonObject),
});
export type Identity = {
	readonly agent: string;
	readonly instance: string;
	readonly request: string;
	readonly kind: "human" | "agent";
	readonly label?: string;
};
export const StoredMessage = Schema.Struct({
	...Message.fields,
	tags: Schema.fromJsonString(Schema.Array(Schema.String)),
	meta: Schema.fromJsonString(Schema.JsonObject),
});
export const validTopic = (topic: string) =>
	topic.length <= 200 && /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(topic);
const eventJson = Schema.encodeSync(Schema.fromJsonString(EventRecord));
const messageRows = Schema.decodeUnknownEffect(Schema.Array(StoredMessage));
const jsonObject = Schema.encodeSync(Schema.fromJsonString(Schema.JsonObject));
const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const boot = yield* BootChannel;
	const crypto = yield* Crypto.Crypto;
	const mutex = yield* Semaphore.make(1);
	const batch = (id: string) =>
		Effect.gen(function* () {
			const rows = yield* sql`SELECT from_seq,to_seq FROM mutation_batches WHERE id=${id}`.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ from_seq: Schema.Int, to_seq: Schema.Int }))),
				),
			);
			const record = rows[0];
			if (!record) return yield* new KernelError({ code: "batch_missing" });
			const outbox = yield* sql`SELECT event FROM outbox WHERE transaction_id=${id} ORDER BY seq`.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ event: Schema.fromJsonString(EventRecord) }))),
				),
			);
			return {
				transaction: id,
				from: record.from_seq,
				to: record.to_seq,
				events: outbox.map((row) => row.event),
			} satisfies Batch;
		});
	const relay = Effect.gen(function* () {
		const pending = yield* sql`SELECT DISTINCT transaction_id FROM outbox WHERE shipped_at IS NULL ORDER BY seq`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ transaction_id: Schema.String })))),
		);
		for (const row of pending) {
			const item = yield* batch(row.transaction_id);
			yield* boot.append(item);
			const now = (yield* DateTime.nowAsDate).getTime();
			yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* writerGate(sql, boot.epoch);
					yield* sql`UPDATE outbox SET shipped_at=${now} WHERE transaction_id=${row.transaction_id}`;
				}),
			);
		}
	});
	const create = (identity: Identity, input: typeof MessageInput.Type, key?: string) =>
		mutex.withPermit(
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
				const probe = Option.getOrNull(yield* Effect.serviceOption(HealthProbe));
				if (!probe) yield* relay;
				const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
				const id = `m_${Buffer.from(yield* crypto.randomBytes(12)).toString("hex")}`;
				const now = (yield* DateTime.nowAsDate).getTime();
				const normalized = { topic: input.topic, body: input.body, tags: input.tags ?? [], meta: input.meta ?? {} };
				const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(MessageInput))(normalized);
				let reservedCount = 0;
				const result = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* writerGate(sql, boot.epoch);
							if (key !== undefined) {
								const previous =
									yield* sql`SELECT input,outcome FROM idempotency WHERE instance=${identity.instance} AND key=${key}`.pipe(
										Effect.flatMap(
											Schema.decodeUnknownEffect(
												Schema.Array(
													Schema.Struct({
														input: Schema.String,
														outcome: Schema.fromJsonString(Message),
													}),
												),
											),
										),
									);
								if (previous[0]) {
									if (previous[0].input !== encoded) return yield* new KernelError({ code: "idempotency_conflict" });
									return previous[0].outcome;
								}
							}
							if (new TextEncoder().encode(encoded).byteLength > 131072)
								return yield* new KernelError({ code: "input_invalid" });
							const deleted =
								yield* sql`SELECT path FROM topics WHERE deleted_at IS NOT NULL AND (path=${input.topic} OR substr(${input.topic},1,length(path)+1)=path||'/') LIMIT 1`;
							if (deleted.length > 0) return yield* new KernelError({ code: "topic_not_found" });
							const archived =
								yield* sql`SELECT path FROM topics WHERE archived_at IS NOT NULL AND (path=${input.topic} OR substr(${input.topic},1,length(path)+1)=path||'/') LIMIT 1`;
							if (archived.length > 0) return yield* new KernelError({ code: "topic_archived" });
							const parts = input.topic.split("/");
							const missing: Array<{ path: string; parent: string | null; name: string }> = [];
							for (let i = 0; i < parts.length; i++) {
								const path = parts.slice(0, i + 1).join("/");
								if ((yield* sql`SELECT path FROM topics WHERE path=${path}`).length === 0)
									missing.push({ path, parent: i === 0 ? null : parts.slice(0, i).join("/"), name: parts[i] ?? "" });
							}
							reservedCount = missing.length + 1;
							if (probe) yield* Ref.set(probe.reservation, { transaction, count: reservedCount });
							const range = yield* boot.reserve(transaction, reservedCount);
							if (probe) yield* Ref.set(probe.ceiling, range.to);
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
							yield* sql`INSERT INTO messages(id,seq,topic,agent,instance,body,tags,meta,created_at) VALUES(${id},${range.to},${input.topic},${identity.agent},${identity.instance},${input.body},${tagsJson},${jsonObject(normalized.meta)},${now})`;
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
							yield* sql`INSERT INTO mutation_batches VALUES(${transaction},${range.from},${range.to},${records.length})`;
							for (const event of records)
								yield* sql`INSERT INTO outbox VALUES(${event.seq},${transaction},${eventJson(event)},NULL)`;
							const outcome = yield* Schema.encodeEffect(Schema.fromJsonString(Message))(message);
							if (key !== undefined)
								yield* sql`INSERT INTO idempotency VALUES(${identity.instance},${key},${encoded},${id},${transaction},${outcome})`;
							return message;
						}),
					)
					.pipe(Effect.result);
				if (result._tag === "Failure") {
					// Typed failure only arrives after successful ROLLBACK; commit/rollback defects stay unresolved.
					if (!probe && reservedCount > 0) {
						yield* boot.reserve(transaction, reservedCount);
						yield* boot.abort(transaction);
					}
					return yield* result.failure;
				}
				if (!probe) yield* relay;
				return result.success;
			}).pipe(Effect.uninterruptible),
		);
	const fence = Effect.gen(function* () {
		const probe = Option.getOrNull(yield* Effect.serviceOption(HealthProbe));
		return probe ? { published_through: yield* Ref.get(probe.ceiling) } : yield* boot.fence;
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
	}) =>
		sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`SELECT epoch FROM kernel_writer`;
				const ceiling = (yield* fence).published_through;
				const since = input.since ?? ceiling;
				if (since > ceiling) return yield* new KernelError({ code: "query_invalid" });
				if (
					(input.tag !== undefined && input.tag.length > 100) ||
					(input.agent !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.agent))
				)
					return yield* new KernelError({ code: "query_invalid" });
				let bodyMatch = sql`1`;
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
   AND (${input.topic ?? null} IS NULL OR topic=${input.topic ?? null} OR ${input.recursive ? 1 : 0}=1 AND substr(topic,1,length(${input.topic ?? ""})+1)=${(input.topic ?? "") + "/"})
   AND (${input.exclude ?? null} IS NULL OR instance<>${input.exclude ?? null})
   AND (${input.agent ?? null} IS NULL OR agent=${input.agent ?? null})
   AND (${input.tag ?? null} IS NULL OR EXISTS (SELECT 1 FROM json_each(visible_messages.tags) WHERE value=${input.tag ?? null}))
   AND ${bodyMatch}
   ORDER BY CASE WHEN ${input.newest ? 1 : 0}=1 THEN -seq ELSE seq END LIMIT ${input.limit}`.pipe(
						Effect.flatMap(messageRows),
					);
				return { items, cursor: items.at(-1)?.seq ?? since, timed_out: false, drained: false };
			}),
		);
	const get = (id: string) =>
		sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`SELECT epoch FROM kernel_writer`;
				const ceiling = (yield* fence).published_through;
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
		moveTopic: (input: typeof TopicMoveCommand.Type) => mutex.withPermit(moveTopic(sql, boot, input)),
		topic: (
			identity: Identity,
			path: string,
			input: typeof TopicMetaInput.Type | typeof TopicArchiveInput.Type,
			key?: string,
		) => mutex.withPermit(mutateTopic(sql, crypto, boot, relay, identity, path, input, key)),
		deleteTopic: (identity: Identity, path: string, key?: string) =>
			mutex.withPermit(deleteTopic(sql, crypto, boot, relay, identity, path, key)),
		toggleReaction: (identity: Identity, input: typeof ReactionInput.Type, key?: string) =>
			mutex.withPermit(toggleReaction(sql, crypto, boot, relay, identity, input, key)),
		reactions: (message: string) => listReactions(sql, fence, message),
		get,
		update: (identity: Identity, id: string, input: typeof MessagePatch.Type, key?: string) =>
			mutex.withPermit(mutateMessage(sql, crypto, boot, relay, identity, id, input, key)),
		remove: (identity: Identity, id: string, key?: string) =>
			mutex.withPermit(mutateMessage(sql, crypto, boot, relay, identity, id, null, key)),
		list,
		mark: (identity: Identity, input: { readonly topic: string; readonly seq: number }, key?: string) =>
			mutex.withPermit(markRead(sql, crypto, boot, relay, identity, input, key)),
		recordEvent: <E = never>(input: OperationalEvent, change?: (seq: number) => Effect.Effect<void, E>) =>
			mutex.withPermit(recordOperationalEvent(sql, boot, relay, input, change)),
		relay: mutex.withPermit(relay),
		quiesce: mutex.withPermit(Effect.void),
		fence,
	};
});
export class Messages extends Context.Service<Messages, Effect.Success<typeof make>>()("comms/server/Messages") {}
export const layer = Layer.effect(Messages, make);
