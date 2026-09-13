import { on } from "@comms/storage/dialect";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

/** Take before boot read/compute/write work, inside its transaction. The persistent
 * allocator row also serializes acquisition when edit_lock has no row. Always take
 * this first: auth and editing publish events in their owning transaction. */
export const lockBootWrite = (sql: SqlClient) => {
	const locked = sql`SELECT singleton FROM seq WHERE singleton=1 FOR UPDATE`.pipe(
		Effect.flatMap((rows) => (rows.length === 1 ? Effect.void : Effect.die("Missing boot writer lock"))),
	);
	return on(sql, { sqlite: () => Effect.void, pg: () => locked, mysql: () => locked });
};
