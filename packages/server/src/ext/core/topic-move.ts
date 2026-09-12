import { TopicMove } from "@comms/protocol/topic-move";
import { Crypto, DateTime, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type EventRecord } from "@comms/protocol/events";
import { type BootChannel, KernelError } from "../../kernel/boot-channel.ts";
import { validTopic } from "./messages.ts";
import type { Identity } from "../../kernel/identity.ts";
import { HealthProbe } from "../../kernel/health-probe.ts";
import type { Mutate } from "../../kernel/mutate.ts";
import { PageContinuation, pendingPageMove, type PageMoveIO } from "./topic-page-continuation.ts";

export const moveTopic = (
	sql: SqlClient,
	mutate: Mutate,
	boot: Pick<BootChannel["Service"], "generation">,
	identity: Identity,
	from: string,
	to: string,
	pages: PageMoveIO,
	key?: string,
) =>
	Effect.gen(function* () {
		if (Option.isSome(yield* Effect.serviceOption(HealthProbe)))
			return yield* new KernelError({ code: "input_invalid" });
		if (
			!validTopic(from) ||
			!validTopic(to) ||
			from === to ||
			from.startsWith(`${to}/`) ||
			to.startsWith(`${from}/`) ||
			(key !== undefined && (key.length < 1 || key.length > 200))
		)
			return yield* new KernelError({ code: "input_invalid" });
		const crypto = yield* Crypto.Crypto;
		const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({ from, to, move: true });
		const event = (seq: number, at: number, type: string): typeof EventRecord.Type => ({
			seq,
			at,
			type,
			level: "info",
			actor: identity.agent,
			instance: identity.instance,
			generation: boot.generation,
			request_id: identity.request,
			topic: to,
			message_id: null,
			payload: { from, to },
		});
		const outcome = yield* mutate({
			...(key === undefined
				? {}
				: {
						idempotency: {
							instance: identity.instance,
							key,
							kind: "topic.moved",
							input: encoded,
							outcome: Schema.fromJsonString(TopicMove),
						},
					}),
			body: (reserve) =>
				Effect.gen(function* () {
					// A keyless retry resumes the exact unfinished page phase, too.
					const pending =
						yield* sql`SELECT seq FROM topic_page_continuations WHERE completed=0 AND from_path=${from} AND to_path=${to}`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Int })))),
						);
					if (pending[0]) return { outcome: { from, to, seq: pending[0].seq }, events: [] };
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
					if (blocked.some((row) => row.deleted_at !== null))
						return yield* new KernelError({ code: "topic_not_found" });
					if (blocked.length) return yield* new KernelError({ code: "topic_archived" });
					const destination =
						yield* sql`SELECT path FROM topics WHERE path=${to} OR substr(path,1,length(${to})+1)=${to + "/"} LIMIT 1`;
					if (destination.length) return yield* new KernelError({ code: "topic_exists" });
					const paths =
						yield* sql`SELECT path FROM topics WHERE path=${from} OR substr(path,1,length(${from})+1)=${from + "/"}`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ path: Schema.String })))),
						);

					const mapped = (path: string) => to + path.slice(from.length);
					if (paths.some((row) => !validTopic(mapped(row.path))))
						return yield* new KernelError({ code: "input_invalid" });
					const invalid =
						yield* sql`SELECT topic FROM messages WHERE (topic=${from} OR substr(topic,1,length(${from})+1)=${from + "/"}) AND length(topic)-length(${from})+length(${to})>200 UNION ALL SELECT topic FROM reads WHERE (topic=${from} OR substr(topic,1,length(${from})+1)=${from + "/"}) AND length(topic)-length(${from})+length(${to})>200 LIMIT 1`;
					if (invalid.length) return yield* new KernelError({ code: "input_invalid" });
					if ((yield* pendingPageMove(sql, from)).length || (yield* pendingPageMove(sql, to)).length)
						return yield* new KernelError({ code: "topic_move_pending" });
					const range = yield* reserve(1);
					const marker = yield* crypto.randomUUIDv4;
					const hasPages = yield* pages.prepare(from, to, marker);
					if (!paths.length && !hasPages) return yield* new KernelError({ code: "topic_not_found" });
					if (hasPages) yield* sql`INSERT INTO topic_page_continuations VALUES(${range.to},${from},${to},${marker},0)`;
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

					return { outcome, events: [event(range.to, now, "topic.moved")] };
				}),
		});
		// An idempotent replay still finishes its own continuation. Legacy receipts have none.
		yield* mutate({
			body: (reserve) =>
				Effect.gen(function* () {
					const rows = yield* sql`SELECT * FROM topic_page_continuations WHERE seq=${outcome.seq}`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PageContinuation))),
					);
					const move = rows[0];
					if (!move || move.completed === 1) return { outcome: undefined, events: [] };
					if (move.from_path !== from || move.to_path !== to)
						return yield* new KernelError({ code: "topic_move_evidence_invalid" });
					const range = yield* reserve(1);
					yield* pages.finish(move);
					yield* sql`UPDATE topic_page_continuations SET completed=1 WHERE seq=${move.seq}`;
					return {
						outcome: undefined,
						events: [event(range.to, (yield* DateTime.nowAsDate).getTime(), "topic.pages_moved")],
					};
				}),
		});
		return outcome;
	});
