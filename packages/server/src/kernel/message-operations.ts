import { type Crypto, DateTime, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type BootChannel, EventRecord, KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";
import { type Identity, Message, MessageInput, StoredMessage } from "./messages.ts";

export const MessagePatch = Schema.Struct({
	body: Schema.optionalKey(Schema.String),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	meta: Schema.optionalKey(Schema.JsonObject),
});

// Called under Messages' permit through SQL commit and immediate outbox publication.
export const mutateMessage = <E>(
	sql: SqlClient,
	crypto: Crypto.Crypto,
	boot: BootChannel["Service"],
	relay: Effect.Effect<void, E>,
	identity: Identity,
	id: string,
	input: typeof MessagePatch.Type | null,
	key?: string,
) =>
	Effect.gen(function* () {
		if (
			!/^m_[a-z0-9]+$/.test(id) ||
			(key !== undefined && (key.length < 1 || key.length > 200)) ||
			(input !== null &&
				(Object.keys(input).length === 0 ||
					input.body === "" ||
					(input.body?.length ?? 0) > 65536 ||
					(input.tags?.length ?? 0) > 100 ||
					input.tags?.some((tag) => tag.length > 100)))
		)
			return yield* new KernelError({ code: "input_invalid" });
		yield* relay;
		const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
			method: input === null ? "DELETE" : "PATCH",
			id,
			input,
		});
		const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
		const now = (yield* DateTime.nowAsDate).getTime();
		let reserved = false;
		const result = yield* sql
			.withTransaction(
				Effect.gen(function* () {
					yield* writerGate(sql, boot.epoch);
					const rows = yield* sql`SELECT * FROM messages WHERE id=${id}`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredMessage))),
					);
					const previous = rows[0];
					if (!previous) return yield* new KernelError({ code: "message_not_found" });
					if (identity.kind !== "human" && identity.instance !== previous.instance)
						return yield* new KernelError({ code: "author_required" });
					if (key !== undefined) {
						const receipts =
							yield* sql`SELECT input,outcome FROM idempotency WHERE instance=${identity.instance} AND key=${key}`.pipe(
								Effect.flatMap(
									Schema.decodeUnknownEffect(
										Schema.Array(Schema.Struct({ input: Schema.String, outcome: Schema.fromJsonString(Message) })),
									),
								),
							);
						if (receipts[0]) {
							if (receipts[0].input !== encoded) return yield* new KernelError({ code: "idempotency_conflict" });
							return receipts[0].outcome;
						}
					}
					const deleted =
						yield* sql`SELECT path FROM topics WHERE deleted_at IS NOT NULL AND (path=${previous.topic} OR substr(${previous.topic},1,length(path)+1)=path||'/') LIMIT 1`;
					if (deleted.length > 0) return yield* new KernelError({ code: "topic_not_found" });
					if (previous.deleted_at !== null) {
						if (input === null) {
							if (key !== undefined) {
								const outcome = yield* Schema.encodeEffect(Schema.fromJsonString(Message))(previous);
								yield* sql`INSERT INTO idempotency VALUES(${identity.instance},${key},${encoded},${id},(SELECT transaction_id FROM outbox WHERE seq=(SELECT updated_seq FROM messages WHERE id=${id})),${outcome})`;
							}
							return previous;
						}
						return yield* new KernelError({ code: "message_not_found" });
					}
					const archived =
						yield* sql`SELECT path FROM topics WHERE archived_at IS NOT NULL AND (path=${previous.topic} OR substr(${previous.topic},1,length(path)+1)=path||'/') LIMIT 1`;
					if (archived.length > 0) return yield* new KernelError({ code: "topic_archived" });
					const message = input === null ? { ...previous, deleted_at: now } : { ...previous, ...input, edited_at: now };
					if (input !== null) {
						const content = yield* Schema.encodeEffect(Schema.fromJsonString(MessageInput))(message);
						if (new TextEncoder().encode(content).byteLength > 131072)
							return yield* new KernelError({ code: "input_invalid" });
					}
					reserved = true;
					const range = yield* boot.reserve(transaction, 1);
					const outcome = yield* Schema.encodeEffect(Schema.fromJsonString(Message))(message);
					const before = yield* Schema.encodeEffect(Schema.fromJsonString(Message))(previous);
					const tags = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(message.tags);
					const meta = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))(message.meta);
					yield* sql`UPDATE messages SET body=${message.body},tags=${tags},meta=${meta},edited_at=${message.edited_at},deleted_at=${message.deleted_at},updated_seq=${range.from},previous=${before} WHERE id=${id}`;
					const event = {
						seq: range.from,
						at: now,
						type: input === null ? "message.deleted" : "message.edited",
						level: "info" as const,
						actor: identity.agent,
						instance: identity.instance,
						generation: boot.generation,
						request_id: identity.request,
						topic: previous.topic,
						message_id: id,
						payload: message,
					};
					const eventJson = yield* Schema.encodeEffect(Schema.fromJsonString(EventRecord))(event);
					yield* sql`INSERT INTO mutation_batches VALUES(${transaction},${range.from},${range.to},1)`;
					yield* sql`INSERT INTO outbox VALUES(${range.from},${transaction},${eventJson},NULL)`;
					if (key !== undefined)
						yield* sql`INSERT INTO idempotency VALUES(${identity.instance},${key},${encoded},${id},${transaction},${outcome})`;
					return message;
				}),
			)
			.pipe(Effect.result);
		if (result._tag === "Failure") {
			// Typed failures confirm rollback; uncertain commit/rollback defects remain for fenced recovery.
			if (reserved) {
				yield* boot.reserve(transaction, 1);
				yield* boot.abort(transaction);
			}
			return yield* result.failure;
		}
		yield* relay;
		return result.success;
	}).pipe(Effect.uninterruptible);
