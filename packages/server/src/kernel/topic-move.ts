import { type Crypto, DateTime, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type BootChannel, EventRecord, KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";
import { lookupIdempotency, storeIdempotency } from "./idempotency.ts";
import { validTopic } from "./messages.ts";

export const TopicMove = Schema.Struct({ from: Schema.String, to: Schema.String, seq: Schema.Int });
export const TopicMoveCommand = Schema.Struct({
	transaction: Schema.String,
	from: Schema.String,
	to: Schema.String,
	page_source: Schema.Boolean,
	identity: Schema.Struct({
		agent: Schema.String,
		instance: Schema.String,
		request: Schema.String,
		kind: Schema.Literals(["human", "agent"]),
		label: Schema.optionalKey(Schema.String),
	}),
	key: Schema.optionalKey(Schema.String),
});

// Boot has paused all application traffic and verified the page tree. It owns reservation
// resolution and pages-first publication, including after an uncertain child response.
export const moveTopic = (
	sql: SqlClient,
	crypto: Crypto.Crypto,
	boot: BootChannel["Service"],
	input: typeof TopicMoveCommand.Type,
) =>
	Effect.gen(function* () {
		const { from, to, transaction, identity, key } = input;
		if (
			!validTopic(from) ||
			!validTopic(to) ||
			from === to ||
			from.startsWith(`${to}/`) ||
			to.startsWith(`${from}/`) ||
			!transaction ||
			transaction.length > 200 ||
			(key !== undefined && (key.length < 1 || key.length > 200))
		)
			return yield* new KernelError({ code: "input_invalid" });
		const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({ from, to, move: true });
		const receipt =
			key === undefined
				? undefined
				: {
						instance: identity.instance,
						key,
						kind: "topic.moved",
						input: encoded,
						outcome: Schema.fromJsonString(TopicMove),
					};
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* writerGate(sql, boot.epoch);
				if (receipt) {
					const previous = yield* lookupIdempotency(sql, crypto, receipt);
					if (Option.isSome(previous)) return previous.value;
				}
				const previous = yield* sql`SELECT event FROM outbox WHERE transaction_id=${transaction}`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ event: Schema.fromJsonString(EventRecord) }))),
					),
				);
				if (previous.length) {
					const event = previous[0]?.event;
					if (
						previous.length !== 1 ||
						!event ||
						event.type !== "topic.moved" ||
						event.actor !== identity.agent ||
						event.instance !== identity.instance ||
						!Schema.is(Schema.Struct({ from: Schema.String, to: Schema.String }))(event.payload) ||
						event.payload.from !== from ||
						event.payload.to !== to
					)
						return yield* new KernelError({ code: "idempotency_conflict" });
					return { from, to, seq: event.seq };
				}
				const blocked =
					yield* sql`SELECT archived_at,deleted_at FROM topics WHERE (path=${from} OR substr(${from},1,length(path)+1)=path||'/' OR path=${to} OR substr(${to},1,length(path)+1)=path||'/') AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Array(
									Schema.Struct({ archived_at: Schema.NullOr(Schema.Int), deleted_at: Schema.NullOr(Schema.Int) }),
								),
							),
						),
					);
				if (blocked.some((row) => row.deleted_at !== null)) return yield* new KernelError({ code: "topic_not_found" });
				if (blocked.length) return yield* new KernelError({ code: "topic_archived" });
				const destination =
					yield* sql`SELECT path FROM topics WHERE path=${to} OR substr(path,1,length(${to})+1)=${to + "/"} LIMIT 1`;
				if (destination.length) return yield* new KernelError({ code: "topic_exists" });
				const paths =
					yield* sql`SELECT path FROM topics WHERE path=${from} OR substr(path,1,length(${from})+1)=${from + "/"}`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ path: Schema.String })))),
					);
				if (!paths.length && !input.page_source) return yield* new KernelError({ code: "topic_not_found" });
				const mapped = (path: string) => to + path.slice(from.length);
				if (paths.some((row) => !validTopic(mapped(row.path))))
					return yield* new KernelError({ code: "input_invalid" });
				const invalid =
					yield* sql`SELECT topic FROM messages WHERE (topic=${from} OR substr(topic,1,length(${from})+1)=${from + "/"}) AND length(topic)-length(${from})+length(${to})>200 UNION ALL SELECT topic FROM reads WHERE (topic=${from} OR substr(topic,1,length(${from})+1)=${from + "/"}) AND length(topic)-length(${from})+length(${to})>200 LIMIT 1`;
				if (invalid.length) return yield* new KernelError({ code: "input_invalid" });
				const range = yield* boot.reserve(transaction, 1);
				const now = (yield* DateTime.nowAsDate).getTime();
				for (const row of paths) {
					const path = mapped(row.path),
						parts = path.split("/");
					yield* sql`UPDATE topics SET path=${path},parent=${parts.length === 1 ? null : parts.slice(0, -1).join("/")},name=${parts.at(-1) ?? path} WHERE path=${row.path}`;
				}
				// New parent nodes are structural consequences of this one subtree operation.
				const parts = to.split("/");
				for (let i = 0; i < parts.length; i++) {
					const path = parts.slice(0, i + 1).join("/");
					yield* sql`INSERT INTO topics(path,parent,name,meta,last_seq,created_at,updated_seq) VALUES(${path},${i === 0 ? null : parts.slice(0, i).join("/")},${parts[i] ?? ""},'{}',${range.to},${now},${range.to}) ON CONFLICT(path) DO NOTHING`;
				}
				yield* sql`UPDATE messages SET topic=${to}||substr(topic,length(${from})+1) WHERE topic=${from} OR substr(topic,1,length(${from})+1)=${from + "/"}`;
				// Refresh old and new ancestors from their remaining message trees.
				yield* sql`UPDATE topics SET last_seq=COALESCE((SELECT MAX(seq) FROM messages WHERE topic=topics.path OR substr(topic,1,length(topics.path)+1)=topics.path||'/'),0) WHERE path=${to} OR substr(${to},1,length(path)+1)=path||'/' OR path=${from} OR substr(${from},1,length(path)+1)=path||'/'`;
				// Marks can exist before a topic does; preserve the greater explicit cursor on collision.
				yield* sql`INSERT INTO reads(instance,topic,seq) SELECT instance,${to}||substr(topic,length(${from})+1),seq FROM reads WHERE topic=${from} OR substr(topic,1,length(${from})+1)=${from + "/"} ON CONFLICT(instance,topic) DO UPDATE SET seq=MAX(reads.seq,excluded.seq)`;
				yield* sql`DELETE FROM reads WHERE topic=${from} OR substr(topic,1,length(${from})+1)=${from + "/"}`;
				const outcome = { from, to, seq: range.to };
				const event = yield* Schema.encodeEffect(Schema.fromJsonString(EventRecord))({
					seq: range.to,
					at: now,
					type: "topic.moved",
					level: "info",
					actor: identity.agent,
					instance: identity.instance,
					generation: boot.generation,
					request_id: identity.request,
					topic: to,
					message_id: null,
					payload: { from, to },
				});
				yield* sql`INSERT INTO mutation_batches VALUES(${transaction},${range.from},${range.to},1)`;
				yield* sql`INSERT INTO outbox VALUES(${range.to},${transaction},${event},NULL)`;
				if (receipt) yield* storeIdempotency(sql, crypto, receipt, outcome);
				return outcome;
			}),
		);
	}).pipe(Effect.uninterruptible);
