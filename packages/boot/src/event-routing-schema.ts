import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Preserve event JSON as the immutable batch replay identity. */
export const eventRoutingSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE events ADD COLUMN topic TEXT`;
	yield* sql`UPDATE events SET topic=json_extract(event,'$.topic')`;
});

/** Indexed projections keep the original JSON unchanged for batch replay checks. */
export const eventFilterSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE events ADD COLUMN type TEXT GENERATED ALWAYS AS (json_extract(event,'$.type')) VIRTUAL`;
	yield* sql`ALTER TABLE events ADD COLUMN actor TEXT GENERATED ALWAYS AS (json_extract(event,'$.actor')) VIRTUAL`;
	yield* sql`ALTER TABLE events ADD COLUMN instance TEXT GENERATED ALWAYS AS (json_extract(event,'$.instance')) VIRTUAL`;
	yield* sql`ALTER TABLE events ADD COLUMN level TEXT GENERATED ALWAYS AS (json_extract(event,'$.level')) VIRTUAL`;
	yield* sql`CREATE INDEX events_type_seq ON events(type,seq)`;
	yield* sql`CREATE INDEX events_actor_seq ON events(actor,seq)`;
	yield* sql`CREATE INDEX events_instance_seq ON events(instance,seq)`;
	yield* sql`CREATE INDEX events_level_seq ON events(level,seq)`;
	yield* sql`CREATE INDEX events_topic_seq ON events(topic,seq)`;
});
