import { type Crypto, DateTime, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type BootChannel, EventRecord, KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";
import type { Identity } from "./messages.ts";
import { publishedMessages } from "./published-messages.ts";

export const ReactionInput = Schema.Struct({ message: Schema.String, emoji: Schema.String });
export const ReactionResult = Schema.Struct({
	...ReactionInput.fields,
	instance: Schema.String,
	active: Schema.Boolean,
	seq: Schema.Int,
});
export const ReactionList = Schema.Struct({
	items: Schema.Array(Schema.Struct({ instance: Schema.String, emoji: Schema.String })),
	cursor: Schema.Int,
});

// The caller holds Messages' permit through commit and immediate publication.
export const toggleReaction = <E>(
	sql: SqlClient,
	crypto: Crypto.Crypto,
	boot: BootChannel["Service"],
	relay: Effect.Effect<void, E>,
	identity: Identity,
	input: typeof ReactionInput.Type,
	key?: string,
) =>
	Effect.gen(function* () {
		if (
			!/^m_[a-z0-9]+$/.test(input.message) ||
			input.emoji.length === 0 ||
			input.emoji.length > 64 ||
			/[\s\p{Cc}]/u.test(input.emoji) ||
			(key !== undefined && (key.length < 1 || key.length > 200))
		)
			return yield* new KernelError({ code: "input_invalid" });
		yield* relay;
		const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
		const now = (yield* DateTime.nowAsDate).getTime();
		let reserved = false;
		const result = yield* sql
			.withTransaction(
				Effect.gen(function* () {
					yield* writerGate(sql, boot.epoch);
					if (key !== undefined) {
						const receipts =
							yield* sql`SELECT message,emoji,outcome FROM reaction_idempotency WHERE instance=${identity.instance} AND key=${key}`.pipe(
								Effect.flatMap(
									Schema.decodeUnknownEffect(
										Schema.Array(
											Schema.Struct({
												message: Schema.String,
												emoji: Schema.String,
												outcome: Schema.fromJsonString(ReactionResult),
											}),
										),
									),
								),
							);
						const receipt = receipts[0];
						if (receipt) {
							if (receipt.message !== input.message || receipt.emoji !== input.emoji)
								return yield* new KernelError({ code: "idempotency_conflict" });
							return receipt.outcome;
						}
					}
					const messages = yield* sql`SELECT topic FROM messages WHERE id=${input.message} AND deleted_at IS NULL`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ topic: Schema.String })))),
					);
					const message = messages[0];
					if (!message) return yield* new KernelError({ code: "message_not_found" });
					const deleted =
						yield* sql`SELECT path FROM topics WHERE deleted_at IS NOT NULL AND (path=${message.topic} OR substr(${message.topic},1,length(path)+1)=path||'/') LIMIT 1`;
					if (deleted.length > 0) return yield* new KernelError({ code: "topic_not_found" });
					const archived =
						yield* sql`SELECT path FROM topics WHERE archived_at IS NOT NULL AND (path=${message.topic} OR substr(${message.topic},1,length(path)+1)=path||'/') LIMIT 1`;
					if (archived.length) return yield* new KernelError({ code: "topic_archived" });
					const reactions =
						yield* sql`SELECT active FROM reactions WHERE message_id=${input.message} AND instance=${identity.instance} AND emoji=${input.emoji}`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ active: Schema.Int })))),
						);
					const previous = reactions[0]?.active ?? 0;
					reserved = true;
					const range = yield* boot.reserve(transaction, 1);
					const outcome = { ...input, instance: identity.instance, active: previous === 0, seq: range.from };
					yield* sql`INSERT INTO reactions(message_id,instance,emoji,active,previous_active,updated_seq) VALUES(${input.message},${identity.instance},${input.emoji},${outcome.active ? 1 : 0},${previous},${range.from}) ON CONFLICT(message_id,instance,emoji) DO UPDATE SET previous_active=active,active=excluded.active,updated_seq=excluded.updated_seq`;
					const event = {
						seq: range.from,
						at: now,
						type: "reaction.added",
						level: "info" as const,
						actor: identity.agent,
						instance: identity.instance,
						generation: boot.generation,
						request_id: identity.request,
						topic: message.topic,
						message_id: input.message,
						payload: outcome,
					};
					const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(EventRecord))(event);
					yield* sql`INSERT INTO mutation_batches VALUES(${transaction},${range.from},${range.to},1)`;
					yield* sql`INSERT INTO outbox VALUES(${range.from},${transaction},${encoded},NULL)`;
					if (key !== undefined) {
						const receipt = yield* Schema.encodeEffect(Schema.fromJsonString(ReactionResult))(outcome);
						yield* sql`INSERT INTO reaction_idempotency VALUES(${identity.instance},${key},${input.message},${input.emoji},${receipt})`;
					}
					return outcome;
				}),
			)
			.pipe(Effect.result);
		if (result._tag === "Failure") {
			if (reserved) {
				yield* boot.reserve(transaction, 1);
				yield* boot.abort(transaction);
			}
			return yield* result.failure;
		}
		yield* relay;
		return result.success;
	}).pipe(Effect.uninterruptible);

export const listReactions = <E>(
	sql: SqlClient,
	fence: Effect.Effect<{ readonly published_through: number }, E>,
	message: string,
) =>
	sql.withTransaction(
		Effect.gen(function* () {
			if (!/^m_[a-z0-9]+$/.test(message)) return yield* new KernelError({ code: "input_invalid" });
			// Establish the snapshot before capturing boot's fence, as for message edits.
			yield* sql`SELECT epoch FROM kernel_writer`;
			const ceiling = (yield* fence).published_through;
			const targets =
				yield* sql`WITH visible AS (${publishedMessages(sql, ceiling)}) SELECT id FROM visible WHERE id=${message} AND deleted_at IS NULL`;
			if (!targets.length) return yield* new KernelError({ code: "message_not_found" });
			const items =
				yield* sql`SELECT instance,emoji FROM reactions WHERE message_id=${message} AND (CASE WHEN updated_seq>${ceiling} THEN previous_active ELSE active END)=1 ORDER BY emoji,instance`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(ReactionList.fields.items)),
				);
			return { items, cursor: ceiling };
		}),
	);
