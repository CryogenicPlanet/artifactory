import { Cause, Effect, FileSystem, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { readStoragePolicy } from "./settings-schema.ts";
import type { StorageVolume } from "./storage-volume.ts";

export class EventStorageRejected extends Schema.TaggedError<EventStorageRejected>()("EventStorageRejected", {
	code: Schema.Literals(["event_storage_unavailable", "event_storage_over_budget"]),
}) {}

type Usage = {
	readonly allocated_bytes: number;
	readonly event_bytes: number;
	readonly other_database_bytes: number;
	readonly wal_bytes: number;
	readonly retained_database_bytes: number;
	readonly incremental_reclaim: boolean;
	readonly limit_bytes: number;
	readonly reusable_database_bytes: number;
	readonly deleted: number;
};
export type EventStorageStatus =
	| { readonly status: "unavailable"; readonly reason: string }
	| (Usage & { readonly status: "within_budget" })
	| (Usage & {
			readonly status: "over_budget";
			readonly reason: "no_prunable_events" | "pruning_in_progress" | "reclaim_pending" | "reclaim_unavailable";
	  });

/** Conservatively charges events plus shared free pages/WAL; never deletes recovery or identity records. */
export const makeEventStorage = <R>(volume: Effect.Effect<StorageVolume, never, R>) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const fs = yield* FileSystem.FileSystem;
		const state = yield* Ref.make<EventStorageStatus>({ status: "unavailable", reason: "not_measured" });
		const measure = Effect.gen(function* () {
			const rows = yield* sql`SELECT
				(SELECT coalesce(sum(pgsize),0) FROM dbstat WHERE aggregate=TRUE AND name IN
				(SELECT name FROM sqlite_schema WHERE tbl_name='events')) AS event_bytes,
				page_size*freelist_count AS free_bytes, page_size*page_count AS database_bytes,
				auto_vacuum FROM pragma_page_size,pragma_freelist_count,pragma_page_count,pragma_auto_vacuum`.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Array(
							Schema.Struct({
								event_bytes: Schema.Int,
								free_bytes: Schema.Int,
								database_bytes: Schema.Int,
								auto_vacuum: Schema.Int,
							}),
						),
					),
				),
			);
			const row = rows[0];
			if (!row) return yield* Effect.die("Missing event storage measurement");
			const databases = yield* sql`PRAGMA database_list`.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String, file: Schema.String }))),
				),
			);
			const filename = databases.find((database) => database.name === "main")?.file;
			if (!filename) return yield* Effect.die("Event storage requires a file-backed database");
			const main = yield* fs.stat(filename);
			const retained = Math.max(0, Number(main.size) - row.database_bytes);
			const wal = yield* fs.stat(`${filename}-wal`).pipe(
				Effect.map((info) => Number(info.size)),
				Effect.catchIf(
					(error) => error.reason._tag === "NotFound",
					() => Effect.succeed(0),
				),
			);
			return {
				allocated_bytes: row.event_bytes + row.free_bytes + retained + wal,
				event_bytes: row.event_bytes,
				other_database_bytes: row.database_bytes - row.event_bytes - row.free_bytes,
				reusable_database_bytes: row.free_bytes,
				wal_bytes: wal,
				retained_database_bytes: retained,
				incremental_reclaim: row.auto_vacuum === 2,
			};
		});
		// Reserve the adapter's connection while temporarily disabling SQLite's busy wait.
		// A reader may prevent truncation; that is retained physical pressure, not success.
		const reclaim = Effect.scoped(
			Effect.gen(function* () {
				const connection = yield* sql.reserve;
				const execute = (statement: string) => connection.executeValues(statement, []);
				const timeoutRows = yield* execute("PRAGMA busy_timeout");
				const timeout = yield* Schema.decodeUnknownEffect(Schema.Int)(timeoutRows[0]?.[0]);
				yield* Effect.acquireUseRelease(
					execute("PRAGMA busy_timeout=0"),
					() =>
						Effect.gen(function* () {
							yield* execute("PRAGMA wal_checkpoint(PASSIVE)");
							yield* execute("PRAGMA incremental_vacuum(256)");
							yield* execute("PRAGMA wal_checkpoint(TRUNCATE)");
						}),
					() => execute(`PRAGMA busy_timeout=${timeout}`).pipe(Effect.orDie),
				);
			}),
		);
		const prune = Effect.gen(function* () {
			const sample = yield* volume;
			if (sample.status === "unavailable") {
				return yield* Ref.set(state, { status: "unavailable", reason: sample.reason });
			}
			const policy = yield* readStoragePolicy.pipe(Effect.provideService(SqlClient.SqlClient, sql));
			const limit = Math.floor((sample.capacity_bytes * policy.event_percent) / 100);
			let deleted = 0;
			// Limit each pass as well as each transaction. A large backlog resumes on the next tick.
			for (let chunk = 0; chunk <= 8; chunk++) {
				yield* reclaim;
				const measured = yield* measure;
				const result = yield* sql.withTransaction(
					Effect.gen(function* () {
						const usage = { ...measured, limit_bytes: limit, deleted };
						if (usage.allocated_bytes <= limit)
							return { status: "within_budget", ...usage } satisfies EventStorageStatus;
						yield* Ref.set(state, { status: "over_budget", reason: "pruning_in_progress", ...usage });
						const rows =
							yield* sql`SELECT seq FROM events WHERE seq<=(SELECT published_through FROM seq WHERE singleton=1)
						ORDER BY seq LIMIT 256`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Int })))),
							);
						if (!rows.length) {
							if (usage.reusable_database_bytes > 0 && usage.incremental_reclaim && chunk < 8) return null;
							const reason =
								usage.reusable_database_bytes > 0
									? usage.incremental_reclaim
										? "reclaim_pending"
										: "reclaim_unavailable"
									: usage.wal_bytes > 0
										? "reclaim_pending"
										: "no_prunable_events";
							return { status: "over_budget", reason, ...usage } satisfies EventStorageStatus;
						}
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
