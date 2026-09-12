import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";

export const writerGate = (sql: SqlClient.SqlClient, epoch: string) =>
	Effect.gen(function* () {
		const rows = yield* sql`UPDATE kernel_writer SET epoch=epoch WHERE singleton=1 AND epoch=${epoch} RETURNING epoch`;
		if (rows.length !== 1) return yield* new KernelError({ code: "stale_writer" });
	});
