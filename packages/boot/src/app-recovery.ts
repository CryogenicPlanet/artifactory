import { appStoreIdentity, verifyAppIdentity } from "./app-store-identity.ts";
import { decodeRows } from "./decode-rows.ts";
import { clientLayer } from "@comms/storage/client";
import type { FileStore } from "@comms/storage/store";
import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type Batch, Events, EventError, EventRecord } from "./events.ts";

/** Shared startup evidence boundary; caller must first prove every previous app owner closed. */
export const fenceAppStore = (filename: string, epoch: string, rejectedAttempt?: string, dataDirectory?: string) =>
	Effect.gen(function* () {
		const bootSql = yield* SqlClient.SqlClient;
		const events = yield* Events;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const identity = yield* appStoreIdentity(filename, dataDirectory);
		const adoption = yield* identity.reserve;
		const marker = yield* bootSql`SELECT value FROM settings WHERE key='app_store_initialized'`;
		const exists = yield* fs.exists(filename);
		if ((marker.length > 0 || adoption.mode === "legacy" || adoption.phase === "ready") && !exists)
			return yield* new EventError({ code: "app_store_missing" });
		const pending = yield* events.state;
		const evidence = yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`PRAGMA busy_timeout = 2000`;
			yield* sql`PRAGMA synchronous = FULL`;
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					const tables = yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`;
					if (tables.length > 0 || adoption.mode === "legacy" || adoption.phase === "ready") {
						yield* Effect.gen(function* () {
							yield* sql`SELECT singleton,epoch FROM kernel_writer LIMIT 0`;
							yield* sql`SELECT id,from_seq,to_seq,count FROM mutation_batches LIMIT 0`;
							yield* sql`SELECT seq,transaction_id,event,shipped_at FROM outbox LIMIT 0`;
						}).pipe(Effect.mapError(() => new EventError({ code: "app_store_identity_invalid" })));
						const high = yield* sql`SELECT MAX(value) AS value FROM (
						 SELECT COALESCE(MAX(seq),0) AS value FROM outbox
						 UNION ALL SELECT COALESCE(MAX(to_seq),0) AS value FROM mutation_batches
						)`.pipe(decodeRows(Schema.Struct({ value: Schema.Int })));
						if ((high[0]?.value ?? 0) >= pending.next) return yield* new EventError({ code: "app_evidence_invalid" });
					}
					yield* verifyAppIdentity(adoption, adoption.phase === "pending");
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
								decodeRows(
									Schema.Struct({
										id: Schema.String,
										from_seq: Schema.Int,
										to_seq: Schema.Int,
										count: Schema.Int,
									}),
								),
							);
						const rows =
							yield* sql`SELECT seq,transaction_id,event FROM outbox WHERE transaction_id=${pending.pending_id} OR seq BETWEEN ${pending.pending_from} AND ${pending.pending_to} ORDER BY seq`.pipe(
								decodeRows(Schema.Struct({ seq: Schema.Int, transaction_id: Schema.String, event: Schema.String })),
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
		}).pipe(Effect.provide(clientLayer({ _tag: "file", filename })), Effect.scoped);
		for (const name of [filename, path.dirname(filename)])
			yield* Effect.scoped(fs.open(name).pipe(Effect.flatMap((file) => file.sync)));
		yield* identity.complete(adoption);
		if (evidence._tag === "Failure") return yield* evidence.failure;
		if (evidence.success && pending.pending_attempt === rejectedAttempt)
			return yield* new EventError({ code: "candidate_probe_committed" });
		// Both SQL scopes are deliberately separate. App writer fence commits before boot resolves.

		return { pending, evidence: evidence.success };
	});

const make = (filename: string, dataDirectory?: string) =>
	Effect.gen(function* () {
		const store: FileStore = { _tag: "file", filename };
		const identity = yield* appStoreIdentity(filename, dataDirectory);
		const context = Context.pick(
			SqlClient.SqlClient,
			Events,
			FileSystem.FileSystem,
			Path.Path,
			Crypto.Crypto,
		)(yield* Effect.context<SqlClient.SqlClient | Events | FileSystem.FileSystem | Path.Path | Crypto.Crypto>());
		const path = yield* Path.Path;
		const events = yield* Events;
		return {
			reserveIdentity: identity.reserve,
			identityStatus: identity.status.pipe(Effect.provideContext(context)),
			store,
			filename,
			dataDirectory: dataDirectory ?? path.dirname(filename),
			prepare: (epoch: string, rejectedAttempt?: string) =>
				Effect.gen(function* () {
					const { pending, evidence } = yield* fenceAppStore(filename, epoch, rejectedAttempt, dataDirectory);
					if (pending.pending_id && pending.pending_attempt) {
						if (evidence) yield* events.append(evidence, pending.pending_attempt);
						else yield* events.abort(pending.pending_id, pending.pending_attempt);
					}
				}).pipe(Effect.provideContext(context)),
		};
	});
export class AppRecovery extends Context.Service<AppRecovery, Effect.Success<ReturnType<typeof make>>>()(
	"comms/boot/AppRecovery",
) {}
export const layer = (filename: string, dataDirectory?: string) =>
	Layer.effect(AppRecovery, make(filename, dataDirectory));
