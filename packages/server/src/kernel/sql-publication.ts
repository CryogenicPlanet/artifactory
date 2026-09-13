import { jsonText } from "@comms/storage/dialect";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { KernelError } from "./boot-channel.ts";

import { assertWriterHealthy } from "./lifecycle.ts";

/** Caller pins its SQL snapshot first. A different child cannot share this process's cached fence. */
export const assertSqlPublished = (sql: SqlClient, epoch: string, ceiling: number) =>
	Effect.gen(function* () {
		yield* assertWriterHealthy;
		const rows = yield* sql`SELECT epoch FROM kernel_writer WHERE singleton=1`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ epoch: Schema.String })))),
		);
		if (rows[0]?.epoch !== epoch) return yield* new KernelError({ code: "stale_writer" });
		// Local append advances the cached fence before deleting outbox evidence.
		if (
			(yield* sql`SELECT seq FROM outbox WHERE seq>${ceiling} AND ${jsonText(sql, sql("event"), "type")}='sql.write' LIMIT 1`)
				.length
		)
			return yield* new KernelError({ code: "sql_publication_pending" });
	});
