import { Cause, Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

const Days = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 36500 }));
const Policy = Schema.Struct({ http_request_days: Days, other_days: Days });
const Rows = Schema.Array(Schema.Struct({ seq: Schema.Int }));
const day = 86_400_000;

/** Prunes published event payloads only; allocator and batch receipts must survive replay. */
export const pruneEvents = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const now = yield* Clock.currentTimeMillis;
	const settings = yield* sql`SELECT value FROM settings WHERE key='event_retention'`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
	);
	const policy = settings[0]
		? yield* Schema.decodeEffect(Schema.fromJsonString(Policy))(settings[0].value)
		: { http_request_days: 7, other_days: 30 };
	const state = yield* sql`SELECT published_through FROM seq WHERE singleton=1`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ published_through: Schema.Int })))),
	);
	const fence = state[0]?.published_through;
	if (fence === undefined) return yield* Effect.die("Missing sequence row");
	let cursor = 0;
	let deleted = 0;
	while (cursor < fence) {
		const batch = yield* sql.withTransaction(
			Effect.gen(function* () {
				// Bound rows scanned, not just rows deleted: young rows may be interleaved with expired ones.
				const rows =
					yield* sql`SELECT seq FROM events WHERE seq>${cursor} AND seq<=${fence} ORDER BY seq LIMIT 256`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
					);
				const end = rows.at(-1)?.seq;
				if (end === undefined) return { cursor: fence, deleted: 0 };
				const removed = yield* sql`DELETE FROM events WHERE seq>${cursor} AND seq<=${end}
				AND json_extract(event,'$.at') < CASE WHEN json_extract(event,'$.type')='http.request'
				THEN ${now - policy.http_request_days * day} ELSE ${now - policy.other_days * day} END RETURNING seq`;
				return { cursor: end, deleted: removed.length };
			}),
		);
		cursor = batch.cursor;
		deleted += batch.deleted;
		// Release SQLite between chunks so retention cannot hold up authentication or supervision.
		if (cursor < fence) yield* Effect.sleep("10 millis");
	}
	return deleted;
});

/** One boot-scoped serial loop: retry a failed pass next hour, never fail boot recovery. */
export const retainEvents = pruneEvents.pipe(
	Effect.catchCause((cause) =>
		Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError("Event retention failed", cause),
	),
	Effect.andThen(Effect.sleep("1 hour")),
	Effect.forever,
);
