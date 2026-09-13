import {
	appStoreIdentity,
	verifyAppIdentity,
	remoteAppStoreIdentity,
	verifyRemoteAppIdentity,
	type RemoteAdoption,
} from "./app-store-identity.ts";
import { decodeRows } from "./decode-rows.ts";
import { clientLayer } from "@comms/storage/client";
import { asBoot, withDatabase, type FileStore, type RemoteStore, type StoreError } from "@comms/storage/store";
import type { RemoteConnectionRejected } from "@comms/storage/remote-session";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type Batch, Events, EventError, EventRecord } from "./events.ts";

const readEvidence = (pending: Effect.Success<Context.Service.Shape<typeof Events>["state"]>) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
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
					row.transaction_id !== batch.id || row.seq !== batch.from_seq + index || records[index]?.seq !== row.seq,
			)
		)
			return yield* new EventError({ code: "app_evidence_invalid" });
		return {
			transaction: batch.id,
			from: batch.from_seq,
			to: batch.to_seq,
			events: records,
		} satisfies Batch;
	});

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
					return yield* readEvidence(pending).pipe(Effect.result);
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
			checkSchema: Effect.void,
			selectRestored: (_target: RemoteStore) => Effect.fail(new EventError({ code: "app_store_identity_invalid" })),
			store: Effect.succeed(store),
			identityStatus: identity.status.pipe(Effect.provideContext(context)),
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

export type RemoteRecoveryError = EventError | SqlError | StoreError | RemoteConnectionRejected;
export interface RemoteRecoveryOptions {
	readonly appStore: RemoteStore;
	readonly bootStore: RemoteStore;
	readonly dataDirectory: string;
	/** Holds the app database advisory lock on the session executing these writes. */
	readonly withWriter: <A, E>(
		store: RemoteStore,
		effect: Effect.Effect<A, E, SqlClient.SqlClient>,
	) => Effect.Effect<A, E | RemoteRecoveryError>;
	readonly withStore: <A, E>(
		store: RemoteStore,
		effect: Effect.Effect<A, E, SqlClient.SqlClient>,
	) => Effect.Effect<A, E | RemoteRecoveryError>;
	/** Pending UUID is durable. Resume fresh schema DDL by that identity before the app transaction. */
	readonly initialize: (adoption: RemoteAdoption) => Effect.Effect<void, RemoteRecoveryError, SqlClient.SqlClient>;
}

export const remoteRecovery = (options: RemoteRecoveryOptions) =>
	Effect.gen(function* () {
		const remoteIdentity = yield* remoteAppStoreIdentity(options.appStore);
		const events = yield* Events;
		const prepare = (epoch: string, rejectedAttempt?: string) =>
			Effect.gen(function* () {
				const adoption = yield* remoteIdentity.reserve;
				const store = yield* withDatabase(options.appStore, adoption.database);
				const bootView = yield* asBoot(store, options.bootStore);
				const pending = yield* events.state;
				const evidence = yield* options.withWriter(
					bootView,
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						if (adoption.phase === "pending") yield* options.initialize(adoption);
						return yield* sql.withTransaction(
							Effect.gen(function* () {
								const created = yield* verifyRemoteAppIdentity(adoption);
								const writers = yield* sql`SELECT singleton,epoch FROM kernel_writer WHERE singleton=1 FOR UPDATE`.pipe(
									decodeRows(Schema.Struct({ singleton: Schema.Int, epoch: Schema.String })),
								);
								if (writers.length === 0 && created)
									yield* sql`INSERT INTO kernel_writer(singleton,epoch) VALUES(1,${epoch})`;
								else if (writers.length !== 1) return yield* new EventError({ code: "app_fence_invalid" });
								yield* sql`UPDATE kernel_writer SET epoch=${epoch} WHERE singleton=1`;
								// Capture failure as data so the new epoch commits even when old evidence is damaged.
								return yield* sql.withTransaction(readEvidence(pending)).pipe(Effect.result);
							}),
						);
					}),
				);
				// The fence committed before the writing session released its advisory lock.
				yield* remoteIdentity.complete(adoption);
				if (evidence._tag === "Failure") return yield* evidence.failure;
				if (evidence.success && pending.pending_attempt === rejectedAttempt)
					return yield* new EventError({ code: "candidate_probe_committed" });
				if (pending.pending_id && pending.pending_attempt) {
					if (evidence.success) yield* events.append(evidence.success, pending.pending_attempt);
					else yield* events.abort(pending.pending_id, pending.pending_attempt);
				}
			});
		const checkSchema = Effect.gen(function* () {
			const adoption = yield* remoteIdentity.reserve;
			if (adoption.phase !== "ready") return yield* new EventError({ code: "app_store_identity_invalid" });
			const store = yield* withDatabase(options.appStore, adoption.database);
			yield* options.withStore(
				store,
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* verifyRemoteAppIdentity(adoption);
					yield* sql`SELECT singleton,epoch FROM kernel_writer LIMIT 0`;
					yield* sql`SELECT id,from_seq,to_seq,count FROM mutation_batches LIMIT 0`;
					yield* sql`SELECT seq,transaction_id,event,shipped_at FROM outbox LIMIT 0`;
				}),
			);
		});
		return {
			checkSchema,
			store: remoteIdentity.store,
			reserveIdentity: remoteIdentity.reserve,
			identityStatus: remoteIdentity.status,
			selectRestored: remoteIdentity.selectRestored,
			filename: undefined,
			dataDirectory: options.dataDirectory,
			prepare,
		};
	});

export class AppRecovery extends Context.Service<
	AppRecovery,
	Effect.Success<ReturnType<typeof make>> | Effect.Success<ReturnType<typeof remoteRecovery>>
>()("comms/boot/AppRecovery") {}
export const layer = (filename: string, dataDirectory?: string) =>
	Layer.effect(AppRecovery, make(filename, dataDirectory));
export const remoteLayer = (options: RemoteRecoveryOptions) => Layer.effect(AppRecovery, remoteRecovery(options));
