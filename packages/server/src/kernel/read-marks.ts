import { type Crypto, DateTime, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type BootChannel, EventRecord, KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";
import { type Identity, validTopic } from "./messages.ts";

export const ReadInput = Schema.Struct({ topic: Schema.String, seq: Schema.Int });
export const ReadResult = ReadInput;
export const effectiveCursor = (sql: SqlClient, instance: string, topic: string) =>
	sql`SELECT COALESCE(MAX(seq),0) AS seq FROM reads WHERE instance=${instance} AND
 (topic=${topic} OR ${topic === "~inbox" ? 0 : 1}=1 AND (topic='' OR substr(${topic},1,length(topic)+1)=topic||'/'))`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Int })))),
		Effect.map((rows) => rows[0]?.seq ?? 0),
	);

// Runs under Messages' mutation permit, including publication, so drain observes this metadata write.
export const markRead = <E>(
	sql: SqlClient,
	crypto: Crypto.Crypto,
	boot: BootChannel["Service"],
	relay: Effect.Effect<void, E>,
	identity: Identity,
	input: typeof ReadInput.Type,
	key?: string,
) =>
	Effect.gen(function* () {
		if (
			(!validTopic(input.topic) && input.topic !== "*" && input.topic !== "~inbox") ||
			!Number.isSafeInteger(input.seq) ||
			input.seq < 0 ||
			(key !== undefined && (key.length < 1 || key.length > 200))
		)
			return yield* new KernelError({ code: "input_invalid" });
		yield* relay;
		const ceiling = (yield* boot.fence).published_through;
		if (input.seq > ceiling) return yield* new KernelError({ code: "input_invalid" });
		const topic = input.topic === "*" ? "" : input.topic;
		const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
		const now = (yield* DateTime.nowAsDate).getTime();
		let reserved = false;
		const result = yield* sql
			.withTransaction(
				Effect.gen(function* () {
					yield* writerGate(sql, boot.epoch);
					if (key !== undefined) {
						const previous =
							yield* sql`SELECT topic,requested_seq,effective_seq FROM read_idempotency WHERE instance=${identity.instance} AND key=${key}`.pipe(
								Effect.flatMap(
									Schema.decodeUnknownEffect(
										Schema.Array(
											Schema.Struct({ topic: Schema.String, requested_seq: Schema.Int, effective_seq: Schema.Int }),
										),
									),
								),
							);
						if (previous[0]) {
							if (previous[0].topic !== topic || previous[0].requested_seq !== input.seq)
								return yield* new KernelError({ code: "idempotency_conflict" });
							return { topic: input.topic, seq: previous[0].effective_seq };
						}
					}
					const deleted =
						yield* sql`SELECT path FROM topics WHERE deleted_at IS NOT NULL AND (path=${topic} OR substr(${topic},1,length(path)+1)=path||'/') LIMIT 1`;
					if (deleted.length > 0) return yield* new KernelError({ code: "topic_not_found" });
					const previous =
						yield* sql`SELECT seq FROM reads WHERE instance=${identity.instance} AND topic=${topic}`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Int })))),
						);
					if (!previous[0] || previous[0].seq < input.seq) {
						reserved = true;
						const range = yield* boot.reserve(transaction, 1);
						yield* sql`INSERT INTO reads VALUES(${identity.instance},${topic},${input.seq}) ON CONFLICT(instance,topic) DO UPDATE SET seq=MAX(reads.seq,excluded.seq)`;
						const event = {
							seq: range.from,
							at: now,
							type: "read.marked",
							level: "info" as const,
							actor: identity.agent,
							instance: identity.instance,
							generation: boot.generation,
							request_id: identity.request,
							topic: topic === "~inbox" || topic === "" ? null : topic,
							message_id: null,
							payload: { topic: input.topic, seq: input.seq },
						};
						const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(EventRecord))(event);
						yield* sql`INSERT INTO mutation_batches VALUES(${transaction},${range.from},${range.to},1)`;
						yield* sql`INSERT INTO outbox VALUES(${range.from},${transaction},${encoded},NULL)`;
					}
					const seq = yield* effectiveCursor(sql, identity.instance, topic);
					if (key !== undefined)
						yield* sql`INSERT INTO read_idempotency VALUES(${identity.instance},${key},${topic},${input.seq},${seq})`;
					return { topic: input.topic, seq };
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
