import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type Batch, Events, EventError, EventRecord } from "./events.ts";

export interface RecoveryHooks<E, R> {
	readonly beforeAppend: (batch: Batch) => Effect.Effect<void, E, R>;
	readonly afterResolve: Effect.Effect<void, E, R>;
}
const noMoves: RecoveryHooks<EventError, never> = { beforeAppend: () => Effect.void, afterResolve: Effect.void };

/** Narrow shared SQL contract. Domain schema remains owned by editable server code. */
const make = (filename: string, hooks: RecoveryHooks<EventError, never>, dataDirectory?: string) =>
	Effect.gen(function* () {
		const bootSql = yield* SqlClient.SqlClient;
		const events = yield* Events;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return {
			filename,
			dataDirectory: dataDirectory ?? path.dirname(filename),
			prepare: (epoch: string, rejectedAttempt?: string) =>
				Effect.gen(function* () {
					const marker = yield* bootSql`SELECT value FROM settings WHERE key='app_store_initialized'`;
					const exists = yield* fs.exists(filename);
					if (marker.length > 0 && !exists) return yield* new EventError({ code: "app_store_missing" });
					const pending = yield* events.state;
					const evidence = yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`PRAGMA busy_timeout = 2000`;
						yield* sql`PRAGMA synchronous = FULL`;
						return yield* sql.withTransaction(
							Effect.gen(function* () {
								if (marker.length === 0) {
									yield* sql`CREATE TABLE IF NOT EXISTS kernel_writer (singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL)`;
									yield* sql`CREATE TABLE IF NOT EXISTS mutation_batches (id TEXT PRIMARY KEY,from_seq INTEGER NOT NULL,to_seq INTEGER NOT NULL,count INTEGER NOT NULL)`;
									yield* sql`CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY,transaction_id TEXT NOT NULL,event TEXT NOT NULL,shipped_at INTEGER)`;
									yield* sql`INSERT OR IGNORE INTO kernel_writer VALUES(1,${epoch})`;
								}
								const updated = yield* sql`UPDATE kernel_writer SET epoch=${epoch} WHERE singleton=1 RETURNING epoch`;
								if (updated.length !== 1) return yield* new EventError({ code: "app_fence_invalid" });
								return yield* Effect.gen(function* () {
									if (!pending.pending_id) return null;
									const batches =
										yield* sql`SELECT id,from_seq,to_seq,count FROM mutation_batches WHERE id=${pending.pending_id}`.pipe(
											Effect.flatMap(
												Schema.decodeUnknownEffect(
													Schema.Array(
														Schema.Struct({
															id: Schema.String,
															from_seq: Schema.Int,
															to_seq: Schema.Int,
															count: Schema.Int,
														}),
													),
												),
											),
										);
									const rows =
										yield* sql`SELECT seq,transaction_id,event FROM outbox WHERE transaction_id=${pending.pending_id} OR seq BETWEEN ${pending.pending_from} AND ${pending.pending_to} ORDER BY seq`.pipe(
											Effect.flatMap(
												Schema.decodeUnknownEffect(
													Schema.Array(
														Schema.Struct({ seq: Schema.Int, transaction_id: Schema.String, event: Schema.String }),
													),
												),
											),
										);
									if (!batches[0] && rows.length === 0) return null;
									const batch = batches[0];
									if (
										!batch ||
										batch.from_seq !== pending.pending_from ||
										batch.to_seq !== pending.pending_to ||
										batch.count !== batch.to_seq - batch.from_seq + 1 ||
										rows.length !== batch.count
									)
										return yield* new EventError({ code: "app_evidence_invalid" });
									const records = yield* Effect.forEach(rows, (row) =>
										Schema.decodeEffect(Schema.fromJsonString(EventRecord))(row.event),
									);
									if (
										rows.some(
											(row, index) =>
												row.transaction_id !== batch.id ||
												row.seq !== batch.from_seq + index ||
												records[index]?.seq !== row.seq,
										)
									)
										return yield* new EventError({ code: "app_evidence_invalid" });
									return {
										transaction: batch.id,
										from: batch.from_seq,
										to: batch.to_seq,
										events: records,
									} satisfies Batch;
								}).pipe(Effect.result);
							}),
						);
					}).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped);
					if (evidence._tag === "Failure") return yield* evidence.failure;
					if (evidence.success && pending.pending_attempt === rejectedAttempt)
						return yield* new EventError({ code: "candidate_probe_committed" });
					// Both SQL scopes are deliberately separate. App writer fence commits before boot resolves.
					yield* bootSql`INSERT OR IGNORE INTO settings(key,value) VALUES('app_store_initialized','1')`;
					if (pending.pending_id && pending.pending_attempt) {
						if (evidence.success) {
							yield* hooks.beforeAppend(evidence.success);
							yield* events.append(evidence.success, pending.pending_attempt);
						} else yield* events.abort(pending.pending_id, pending.pending_attempt);
					}
					yield* hooks.afterResolve;
				}),
		};
	});
export class AppRecovery extends Context.Service<AppRecovery, Effect.Success<ReturnType<typeof make>>>()(
	"comms/boot/AppRecovery",
) {}
export const layer = <E = EventError, R = never>(
	filename: string,
	hooks?: RecoveryHooks<E, R>,
	dataDirectory?: string,
) =>
	Layer.effect(
		AppRecovery,
		Effect.gen(function* () {
			if (!hooks) return yield* make(filename, noMoves, dataDirectory);
			const context = yield* Effect.context<R>();
			const close = <A>(effect: Effect.Effect<A, E, R>) =>
				effect.pipe(
					Effect.provideContext(context),
					Effect.mapError(() => new EventError({ code: "topic_move_recovery_required" })),
				);
			return yield* make(
				filename,
				{
					beforeAppend: (batch) => close(hooks.beforeAppend(batch)),
					afterResolve: close(hooks.afterResolve),
				},
				dataDirectory,
			);
		}),
	);
