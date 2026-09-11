import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export class RecoveryRejected extends Schema.TaggedError<RecoveryRejected>()("RecoveryRejected", {
	code: Schema.Literal("recovery_intents_conflict"),
}) {
	get message() {
		return this.code;
	}
}

/** One recovery operation owns the stores. Read all durable admissions in one SQL snapshot. */
export const recoveryIntents = (sql: SqlClient.SqlClient) =>
	sql`SELECT
		EXISTS(SELECT 1 FROM cutover) AS cutover,
		EXISTS(SELECT 1 FROM db_restore_requests WHERE phase IN ('authorized','restoring','working','rollback')) AS restore,
		(EXISTS(SELECT 1 FROM topic_moves WHERE state IN ('prepared','pages_published'))
		 OR EXISTS(SELECT 1 FROM topic_page_moves WHERE state<>'completed')) AS move,
		EXISTS(SELECT 1 FROM source_batches WHERE state='publishing') AS source`.pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(
				Schema.Array(
					Schema.Struct({
						cutover: Schema.Int,
						restore: Schema.Int,
						move: Schema.Int,
						source: Schema.Int,
					}),
				),
			),
		),
		Effect.flatMap((rows) => {
			const row = rows[0];
			return row
				? Effect.succeed({ ...row, count: row.cutover + row.restore + row.move + row.source })
				: Effect.die("Missing recovery intent snapshot");
		}),
	);
