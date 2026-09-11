import { Context, Deferred, Effect, Layer, Ref, Schema } from "effect";
import { SqlClient, type Statement } from "effect/unstable/sql";
import type { EventStorageRejected } from "./event-storage.ts";
import type { StorageRejected } from "./storage-headroom.ts";
import { movePublicPaths, projectPublicPath } from "./public-paths.ts";

export const EventRecord = Schema.Struct({
	seq: Schema.Int,
	at: Schema.Int,
	type: Schema.String,
	level: Schema.Literals(["debug", "info", "warn", "error"]),
	actor: Schema.String,
	instance: Schema.NullOr(Schema.String),
	generation: Schema.Int,
	request_id: Schema.NullOr(Schema.String),
	topic: Schema.NullOr(Schema.String),
	message_id: Schema.NullOr(Schema.String),
	payload: Schema.Json,
});
export const Batch = Schema.Struct({
	transaction: Schema.String,
	from: Schema.Int,
	to: Schema.Int,
	events: Schema.Array(EventRecord),
});
export type Batch = typeof Batch.Type;
export class EventError extends Schema.TaggedError<EventError>()("EventError", {
	code: Schema.Literals([
		"app_evidence_invalid",
		"app_fence_invalid",
		"app_store_missing",
		"batch_conflict",
		"batch_invalid",
		"body_invalid",
		"body_too_large",
		"candidate_probe_committed",
		"credential_expired",
		"credential_invalid",
		"cursor_ahead",
		"events_unavailable",
		"public_path_invalid",
		"publication_pending",
		"query_invalid",
		"reservation_conflict",
		"reservation_invalid",
		"reservation_mismatch",
		"sequence_exhausted",
		"stale_attempt",
		"topic_move_invalid",
		"topic_move_recovery_required",
		"topic_move_unprepared",
	]),
}) {
	get message() {
		return this.code;
	}
}
const Sequence = Schema.Struct({
	next: Schema.Int,
	published_through: Schema.Int,
	pending_id: Schema.NullOr(Schema.String),
	pending_attempt: Schema.NullOr(Schema.String),
	pending_from: Schema.NullOr(Schema.Int),
	pending_to: Schema.NullOr(Schema.Int),
});
const Move = Schema.Struct({ from: Schema.String, to: Schema.String });
const validTopic = (topic: string) =>
	topic.length <= 200 && /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(topic);
const encode = Schema.encodeSync(Schema.fromJsonString(EventRecord));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(EventRecord));

export const eventsSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE seq (singleton INTEGER PRIMARY KEY CHECK(singleton=1), next INTEGER NOT NULL,
 published_through INTEGER NOT NULL, pending_id TEXT, pending_attempt TEXT, pending_from INTEGER, pending_to INTEGER)`;
	yield* sql`INSERT INTO seq VALUES (1,1,0,NULL,NULL,NULL,NULL)`;
	yield* sql`CREATE TABLE events (seq INTEGER PRIMARY KEY, transaction_id TEXT, event TEXT NOT NULL)`;
	yield* sql`CREATE TABLE event_batches (id TEXT PRIMARY KEY, attempt TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, state TEXT NOT NULL)`;
});

const make = Effect.fn("Events")(function* (
	admitReservation: Effect.Effect<void, StorageRejected | EventStorageRejected>,
) {
	const sql = yield* SqlClient.SqlClient;
	const state =
		sql`SELECT next,published_through,pending_id,pending_attempt,pending_from,pending_to FROM seq WHERE singleton=1`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Sequence))),
			Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.die("Missing sequence row"))),
		);
	const stopped = yield* Ref.make(false);
	const signal = yield* Ref.make(yield* Deferred.make<void>());
	const notify = Effect.gen(function* () {
		const next = yield* Deferred.make<void>();
		const previous = yield* Ref.getAndSet(signal, next);
		yield* Deferred.succeed(previous, undefined);
	});
	const changed = (after: number) =>
		Effect.gen(function* () {
			while (true) {
				// Capture the signal before reading SQL so a commit between read and wait cannot be missed.
				const pending = yield* Ref.get(signal);
				if (yield* Ref.get(stopped)) return yield* new EventError({ code: "events_unavailable" });
				const current = (yield* state).published_through;
				if (current > after) return current;
				yield* Deferred.await(pending);
			}
		});
	const finish = sql`UPDATE seq SET published_through=next-1,pending_id=NULL,pending_attempt=NULL,pending_from=NULL,pending_to=NULL WHERE singleton=1`;
	const append = (batch: Batch, attempt: string) =>
		sql.withTransaction(
			Effect.gen(function* () {
				const current = yield* state;
				const records =
					yield* sql`SELECT attempt,from_seq,to_seq,state FROM event_batches WHERE id=${batch.transaction}`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Array(
									Schema.Struct({
										attempt: Schema.String,
										from_seq: Schema.Int,
										to_seq: Schema.Int,
										state: Schema.String,
									}),
								),
							),
						),
					);
				const record = records[0];
				if (
					!record ||
					(record.state !== "published" && record.attempt !== attempt) ||
					record.from_seq !== batch.from ||
					record.to_seq !== batch.to ||
					record.state === "aborted" ||
					batch.events.length !== batch.to - batch.from + 1 ||
					batch.events.some((event, index) => event.seq !== batch.from + index)
				)
					return yield* new EventError({ code: "batch_invalid" });
				if (record.state === "published") {
					const retained =
						yield* sql`SELECT event FROM events WHERE transaction_id=${batch.transaction} ORDER BY seq`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ event: Schema.String })))),
						);
					// Retention can remove finalized events. Never resurrect them on replay.
					for (const row of retained) {
						const event = yield* decode(row.event);
						const replay = batch.events[event.seq - batch.from];
						if (!replay || encode(event) !== encode(replay)) return yield* new EventError({ code: "batch_conflict" });
					}
					return { published_through: current.published_through };
				}
				if (current.pending_id !== batch.transaction || current.pending_attempt !== attempt)
					return yield* new EventError({ code: "reservation_mismatch" });
				for (const event of batch.events) {
					// Only the first publication applies routing changes. Replays compare the original JSON above.
					if (event.type === "topic.moved") {
						const move = yield* Schema.decodeUnknownEffect(Move)(event.payload).pipe(
							Effect.mapError(() => new EventError({ code: "topic_move_invalid" })),
						);
						if (
							event.topic !== move.to ||
							!validTopic(move.from) ||
							!validTopic(move.to) ||
							move.from === move.to ||
							move.from.startsWith(`${move.to}/`) ||
							move.to.startsWith(`${move.from}/`)
						)
							return yield* new EventError({ code: "topic_move_invalid" });
						const legacy = yield* sql`SELECT id FROM topic_moves WHERE id=${batch.transaction}`;
						if (legacy.length) {
							const prepared =
								yield* sql`SELECT id FROM topic_moves WHERE id=${batch.transaction} AND from_path=${move.from} AND to_path=${move.to} AND state='pages_published' AND (seq IS NULL OR seq=${event.seq})`;
							if (batch.events.length !== 1 || prepared.length !== 1)
								return yield* new EventError({ code: "topic_move_unprepared" });
						}
						yield* sql`UPDATE events SET topic=${move.to} || substr(topic,length(${move.from})+1)
							WHERE topic=${move.from} OR substr(topic,1,length(${move.from})+1)=${`${move.from}/`}`;
						yield* movePublicPaths(sql, move.from, move.to);
						yield* sql`UPDATE topic_moves SET state='completed',seq=${batch.to} WHERE id=${batch.transaction}`;
					}
					const projected = yield* projectPublicPath(sql, event).pipe(
						Effect.catchTag("SchemaError", () => Effect.fail(new EventError({ code: "public_path_invalid" }))),
					);
					if (!projected) return yield* new EventError({ code: "public_path_invalid" });
					yield* sql`INSERT INTO events(seq,transaction_id,event,topic) VALUES(${event.seq},${batch.transaction},${encode(event)},${event.topic})`;
				}
				yield* sql`UPDATE event_batches SET state='published' WHERE id=${batch.transaction}`;
				yield* finish;
				return { published_through: current.next - 1 };
			}),
		);
	const abort = (transaction: string, attempt: string) =>
		sql.withTransaction(
			Effect.gen(function* () {
				const current = yield* state;
				if (current.pending_id !== transaction || current.pending_attempt !== attempt)
					return yield* new EventError({ code: "reservation_mismatch" });
				yield* sql`UPDATE event_batches SET state='aborted' WHERE id=${transaction}`;
				yield* finish;
			}),
		);
	const reserve = (transaction: string, count: number, attempt: string, purpose: "mutation" | "startup") =>
		sql.withTransaction(
			Effect.gen(function* () {
				if (!transaction || transaction.length > 128 || !Number.isSafeInteger(count) || count < 1 || count > 256)
					return yield* new EventError({ code: "reservation_invalid" });
				const current = yield* state;
				const previous =
					yield* sql`SELECT attempt,from_seq,to_seq,state FROM event_batches WHERE id=${transaction}`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Array(
									Schema.Struct({
										attempt: Schema.String,
										from_seq: Schema.Int,
										to_seq: Schema.Int,
										state: Schema.String,
									}),
								),
							),
						),
					);
				if (previous[0]) {
					const row = previous[0];
					if (row.attempt !== attempt || row.to_seq - row.from_seq + 1 !== count || row.state !== "pending")
						return yield* new EventError({ code: "reservation_conflict" });
					return { transaction, from: row.from_seq, to: row.to_seq };
				}
				if (current.pending_id !== null) return yield* new EventError({ code: "publication_pending" });
				const to = current.next + count - 1;
				if (!Number.isSafeInteger(to + 1)) return yield* new EventError({ code: "sequence_exhausted" });
				if (purpose === "mutation") yield* admitReservation;
				yield* sql`INSERT INTO event_batches VALUES(${transaction},${attempt},${current.next},${to},'pending')`;
				yield* sql`UPDATE seq SET next=${to + 1},pending_id=${transaction},pending_attempt=${attempt},pending_from=${current.next},pending_to=${to} WHERE singleton=1`;
				return { transaction, from: current.next, to };
			}),
		);
	return {
		state,
		changed,
		stopWaiting: Ref.set(stopped, true).pipe(Effect.andThen(notify)),
		append: (batch: Batch, attempt: string) => append(batch, attempt).pipe(Effect.ensuring(notify)),
		abort: (transaction: string, attempt: string) => abort(transaction, attempt).pipe(Effect.ensuring(notify)),
		reserve: (transaction: string, count: number, attempt: string) => reserve(transaction, count, attempt, "mutation"),
		// Only boot-authenticated startup probes and unrouted policy completion use this reservation.
		reserveStartup: (transaction: string, count: number, attempt: string) =>
			reserve(transaction, count, attempt, "startup"),
		writeBoot: (event: Omit<typeof EventRecord.Type, "seq">) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						if (event.type === "topic.moved") return yield* new EventError({ code: "topic_move_unprepared" });
						if (event.type === "topic.meta" || event.type === "topic.deleted" || event.type === "pages.public")
							return yield* new EventError({ code: "public_path_invalid" });
						const current = yield* state;
						if (!Number.isSafeInteger(current.next + 1)) return yield* new EventError({ code: "sequence_exhausted" });
						yield* sql`INSERT INTO events(seq,transaction_id,event,topic) VALUES(${current.next},NULL,${encode({ ...event, seq: current.next })},${event.topic})`;
						yield* sql`UPDATE seq SET next=next+1,published_through=CASE WHEN pending_id IS NULL THEN next ELSE published_through END WHERE singleton=1`;
					}),
				)
				.pipe(Effect.ensuring(notify)),
		query: (input: {
			readonly since?: number;
			readonly limit: number;
			readonly topic?: string;
			readonly types?: readonly string[];
			readonly agent?: string;
			readonly instance?: string;
			readonly level?: string;
			readonly requestActor?: string;
			readonly excludeMessageInstance?: string;
		}) =>
			Effect.gen(function* () {
				const fence = (yield* state).published_through;
				const since = input.since ?? fence;
				if (since > fence) return yield* new EventError({ code: "cursor_ahead" });
				if (since === fence) return { items: [], cursor: fence, timed_out: false, drained: false };
				const filters: Array<Statement.Fragment> = [sql`seq>${since}`, sql`seq<=${fence}`];
				if (input.topic !== undefined) filters.push(sql`(topic=${input.topic} OR topic GLOB ${`${input.topic}/*`})`);
				if (input.requestActor !== undefined) filters.push(sql`(type<>'http.request' OR actor=${input.requestActor})`);
				if (input.excludeMessageInstance !== undefined)
					filters.push(sql`(type NOT GLOB 'message.*' OR instance IS NOT ${input.excludeMessageInstance})`);
				if (input.agent !== undefined) filters.push(sql`actor=${input.agent}`);
				if (input.instance !== undefined) filters.push(sql`instance=${input.instance}`);
				if (input.level !== undefined) filters.push(sql`level=${input.level}`);
				if (input.types?.length)
					filters.push(
						sql.or(
							input.types.map((type) =>
								type.endsWith("*")
									? sql`type GLOB ${`${type.slice(0, -1).replace(/[?*[]/g, (character) => `[${character}]`)}*`}`
									: sql`type=${type}`,
							),
						),
					);
				// SQLite otherwise prefers sequence order over selective prefix indexes and scans unrelated history.
				const index = (
					[
						["events_actor_seq", input.agent !== undefined],
						["events_instance_seq", input.instance !== undefined],
						["events_level_seq", input.level !== undefined],
						["events_type_seq", Boolean(input.types?.length && !input.types.includes("*"))],
						["events_topic_seq", input.topic !== undefined],
					] as const
				).find(([, present]) => present)?.[0];
				// A nearly caught-up query can inspect at most one page of sequence values; prefix indexes
				// would instead revisit older matching history because their second key cannot bound that range.
				let indexed = sql``;
				if (fence - since <= input.limit + 1) indexed = sql`NOT INDEXED`;
				else if (index !== undefined) indexed = sql`INDEXED BY ${sql(index)}`;
				// One lookahead distinguishes a full page from exhausted filtered history. Only decode returned rows.
				const rows =
					yield* sql`SELECT event,topic FROM events ${indexed} WHERE ${sql.and(filters)} ORDER BY seq LIMIT ${input.limit + 1}`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Array(Schema.Struct({ event: Schema.String, topic: Schema.NullOr(Schema.String) })),
							),
						),
					);
				const items = yield* Effect.forEach(rows.slice(0, input.limit), (row) =>
					decode(row.event).pipe(Effect.map((event) => ({ ...event, topic: row.topic }))),
				);
				return {
					items,
					cursor: rows.length > input.limit ? (items.at(-1)?.seq ?? since) : fence,
					timed_out: false,
					drained: false,
				};
			}),
	};
});
export class Events extends Context.Service<Events, Effect.Success<ReturnType<typeof make>>>()("comms/boot/Events") {}
export const layer = (admitReservation: Effect.Effect<void, StorageRejected | EventStorageRejected>) =>
	Layer.effect(Events, make(admitReservation));
