import { on } from "@comms/storage/dialect";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";

export const writerGate = (sql: SqlClient.SqlClient, epoch: string) =>
	Effect.gen(function* () {
		const rows = yield* on(sql, {
			sqlite: () => sql`UPDATE kernel_writer SET epoch=epoch WHERE singleton=1 AND epoch=${epoch} RETURNING epoch`,
			pg: () => sql`UPDATE kernel_writer SET epoch=epoch WHERE singleton=1 AND epoch=${epoch} RETURNING epoch`,
			// A no-op UPDATE reports zero changed rows on MySQL. Lock and inspect instead.
			mysql: () => sql`SELECT epoch FROM kernel_writer WHERE singleton=1 AND epoch=${epoch} FOR UPDATE`,
		});
		if (rows.length !== 1) return yield* new KernelError({ code: "stale_writer" });
	});
