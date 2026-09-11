import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Preserve event JSON as the immutable batch replay identity. */
export const eventRoutingSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE events ADD COLUMN topic TEXT`;
	yield* sql`UPDATE events SET topic=json_extract(event,'$.topic')`;
});
