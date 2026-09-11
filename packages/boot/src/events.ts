import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

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
export class EventError extends Schema.TaggedError<EventError>()("EventError", { code: Schema.String }) {
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

const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const state =
		sql`SELECT next,published_through,pending_id,pending_attempt,pending_from,pending_to FROM seq WHERE singleton=1`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Sequence))),
			Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.die("Missing sequence row"))),
		);
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
				for (const event of batch.events)
					yield* sql`INSERT INTO events(seq,transaction_id,event) VALUES(${event.seq},${batch.transaction},${encode(event)})`;
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
	return {
		state,
		append,
		abort,
		reserve: (transaction: string, count: number, attempt: string) =>
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
					yield* sql`INSERT INTO event_batches VALUES(${transaction},${attempt},${current.next},${to},'pending')`;
					yield* sql`UPDATE seq SET next=${to + 1},pending_id=${transaction},pending_attempt=${attempt},pending_from=${current.next},pending_to=${to} WHERE singleton=1`;
					return { transaction, from: current.next, to };
				}),
			),
		writeBoot: (event: Omit<typeof EventRecord.Type, "seq">) =>
			sql.withTransaction(
				Effect.gen(function* () {
					const current = yield* state;
					if (!Number.isSafeInteger(current.next + 1)) return yield* new EventError({ code: "sequence_exhausted" });
					yield* sql`INSERT INTO events(seq,transaction_id,event) VALUES(${current.next},NULL,${encode({ ...event, seq: current.next })})`;
					yield* sql`UPDATE seq SET next=next+1,published_through=CASE WHEN pending_id IS NULL THEN next ELSE published_through END WHERE singleton=1`;
				}),
			),
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
				const types = input.types ?? [];
				const typesJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(types);
				const rows = yield* sql`SELECT event FROM events WHERE seq>${since} AND seq<=${fence}
    AND (${input.topic ?? null} IS NULL OR json_extract(event,'$.topic')=${input.topic ?? null} OR substr(json_extract(event,'$.topic'),1,length(${input.topic ?? ""})+1)=${(input.topic ?? "") + "/"})
    AND (${input.requestActor ?? null} IS NULL OR json_extract(event,'$.type')<>'http.request' OR json_extract(event,'$.actor')=${input.requestActor ?? null})
    AND (${input.excludeMessageInstance ?? null} IS NULL OR substr(json_extract(event,'$.type'),1,8)<>'message.' OR json_extract(event,'$.instance') IS NOT ${input.excludeMessageInstance ?? null})
    AND (${input.agent ?? null} IS NULL OR json_extract(event,'$.actor')=${input.agent ?? null})
    AND (${input.instance ?? null} IS NULL OR json_extract(event,'$.instance')=${input.instance ?? null})
    AND (${input.level ?? null} IS NULL OR json_extract(event,'$.level')=${input.level ?? null})
    AND (${types.length}=0 OR EXISTS(SELECT 1 FROM json_each(${typesJson}) WHERE value=json_extract(event,'$.type') OR substr(value,-1)='*' AND substr(json_extract(event,'$.type'),1,length(value)-1)=substr(value,1,length(value)-1)))
    ORDER BY seq LIMIT ${input.limit}`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ event: Schema.String })))),
				);
				const items: Array<typeof EventRecord.Type> = [];
				for (const row of rows) {
					const event = yield* decode(row.event);
					if (input.topic && event.topic !== input.topic && !event.topic?.startsWith(`${input.topic}/`)) continue;
					if (
						(input.agent && event.actor !== input.agent) ||
						(input.instance && event.instance !== input.instance) ||
						(input.level && event.level !== input.level)
					)
						continue;
					if (
						input.types?.length &&
						!input.types.some((type) =>
							type.endsWith("*") ? event.type.startsWith(type.slice(0, -1)) : event.type === type,
						)
					)
						continue;
					items.push(event);
					if (items.length === input.limit) break;
				}
				return { items, cursor: items.at(-1)?.seq ?? since, timed_out: false, drained: false };
			}),
	};
});
export class Events extends Context.Service<Events, Effect.Success<typeof make>>()("comms/boot/Events") {}
export const layer = Layer.effect(Events, make);
