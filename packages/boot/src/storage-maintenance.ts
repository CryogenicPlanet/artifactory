import { DateTime, Effect, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { scheduledBackup } from "./scheduled-backup.ts";
import type { Supervisor } from "./supervisor.ts";

/** One boot-owned loop; persisted attempt times avoid overlapping work and restart retry storms. */
export const storageMaintenance = Effect.fn("storageMaintenance")(function* (supervisor: Supervisor) {
	const sql = yield* SqlClient.SqlClient;
	const capture = (yield* scheduledBackup(supervisor)).capture;
	const due = (key: string, interval: number, now: number) =>
		sql.withTransaction(
			Effect.gen(function* () {
				const rows = yield* sql`SELECT value FROM settings WHERE key=${key}`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
				);
				const value = rows[0]?.value;
				const previous =
					value === undefined ? null : yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Int))(value);
				if (previous !== null && now - previous < interval) return false;
				yield* sql`INSERT INTO settings(key,value) VALUES(${key},${String(now)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
				return true;
			}),
		);
	const runDue = Effect.gen(function* () {
		if (!(yield* Ref.get(supervisor.current))) return;
		const now = (yield* DateTime.nowAsDate).getTime();
		yield* Effect.gen(function* () {
			if (yield* due("backup.hourly_attempt_at", 60 * 60 * 1000, now)) yield* capture;
		}).pipe(Effect.catchCause(() => Effect.logWarning("Scheduled backup failed; retrying next hour")));
	});
	const run = Effect.gen(function* () {
		while (true) {
			yield* runDue;
			yield* Effect.sleep("1 minute");
		}
	});
	return { runDue, run };
});
