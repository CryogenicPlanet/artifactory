import { Cause, Effect, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { StorageVolume } from "./storage-volume.ts";

export class EventStorageRejected extends Schema.TaggedError<EventStorageRejected>()("EventStorageRejected", {
	code: Schema.Literals(["event_storage_unavailable", "event_storage_over_budget"]),
}) {}

type Usage = {
	readonly allocated_bytes: number;
	readonly limit_bytes: number;
	readonly reusable_database_bytes: number;
	readonly deleted: number;
};
export type EventStorageStatus =
	| { readonly status: "unavailable"; readonly reason: string }
	| (Usage & { readonly status: "within_budget" })
	| (Usage & { readonly status: "over_budget"; readonly reason: "no_prunable_events" | "pruning_in_progress" });
const Bytes = Schema.Array(Schema.Struct({ bytes: Schema.Int }));

/** Budgets allocated event B-tree pages, not shared database/WAL file size. Never removes recovery receipts. */
export const makeEventStorage = <R>(volume: Effect.Effect<StorageVolume, never, R>) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const state = yield* Ref.make<EventStorageStatus>({ status: "unavailable", reason: "not_measured" });
		const allocated = sql`SELECT coalesce(sum(pgsize),0) AS bytes FROM dbstat
			WHERE aggregate=TRUE AND name IN (SELECT name FROM sqlite_schema WHERE tbl_name='events')`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Bytes)),
			Effect.flatMap((rows) =>
				rows[0] ? Effect.succeed(rows[0].bytes) : Effect.die("Missing event page measurement"),
			),
		);
		const prune = Effect.gen(function* () {
			const sample = yield* volume;
			if (sample.status === "unavailable") {
				return yield* Ref.set(state, { status: "unavailable", reason: sample.reason });
			}
			const limit = Math.floor(sample.capacity_bytes / 10);
			let deleted = 0;
			// Limit each pass as well as each transaction. A large backlog resumes on the next tick.
			for (let chunk = 0; chunk <= 8; chunk++) {
				const result = yield* sql.withTransaction(
					Effect.gen(function* () {
						const bytes = yield* allocated;
						const free =
							yield* sql`SELECT page_size*freelist_count AS bytes FROM pragma_page_size,pragma_freelist_count`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Bytes)),
							);
						const usage = {
							allocated_bytes: bytes,
							limit_bytes: limit,
							reusable_database_bytes: free[0]?.bytes ?? 0,
							deleted,
						};
						if (bytes <= limit) return { status: "within_budget", ...usage } satisfies EventStorageStatus;
						yield* Ref.set(state, { status: "over_budget", reason: "pruning_in_progress", ...usage });
						const rows =
							yield* sql`SELECT seq FROM events WHERE seq<=(SELECT published_through FROM seq WHERE singleton=1)
						ORDER BY seq LIMIT 256`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Int })))),
							);
						if (!rows.length)
							return { status: "over_budget", reason: "no_prunable_events", ...usage } satisfies EventStorageStatus;
						if (chunk === 8)
							return { status: "over_budget", reason: "pruning_in_progress", ...usage } satisfies EventStorageStatus;
						const last = rows.at(-1);
						if (last) yield* sql`DELETE FROM events WHERE seq<=${last.seq}`;
						deleted += rows.length;
						return null;
					}),
				);
				if (result) return yield* Ref.set(state, result);
				// Release SQLite between chunks so other borrowers can proceed before the next measurement.
				yield* Effect.sleep("10 millis");
			}
		}).pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Ref.set(state, { status: "unavailable", reason: "measurement_or_pruning_failed" }).pipe(
							Effect.andThen(Effect.logWarning("Event page-budget maintenance failed; retrying next minute", cause)),
						),
			),
		);
		const admit = Effect.gen(function* () {
			const status = yield* Ref.get(state);
			if (status.status !== "within_budget")
				return yield* new EventStorageRejected({
					code: status.status === "over_budget" ? "event_storage_over_budget" : "event_storage_unavailable",
				});
		});
		return {
			prune,
			admit,
			status: Ref.get(state),
			run: prune.pipe(Effect.andThen(Effect.sleep("1 minute")), Effect.forever),
		};
	});
