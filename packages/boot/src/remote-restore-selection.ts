import { withDatabase, type RemoteStore } from "@comms/storage/store";
import { Effect, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { AppRecovery } from "./app-recovery.ts";
import { ChildError } from "./child-process.ts";

const Selection = Schema.Struct({
	engine: Schema.Literals(["postgres", "mysql"]),
	endpoint: Schema.String,
	database: Schema.String,
	store_id: Schema.String,
});
const invalid = () => new ChildError({ code: "restore_recovery_required" });

const selectionOf = (store: RemoteStore, storeId: string) =>
	Effect.try({
		try: () => {
			const url = new URL(Redacted.value(store.url));
			return {
				store,
				selection: {
					engine: store._tag,
					endpoint: `${url.hostname.toLowerCase()}:${url.port || (store._tag === "postgres" ? "5432" : "3306")}`,
					database: store.database,
					store_id: storeId,
				},
			};
		},
		catch: invalid,
	});
type Current = Effect.Effect<Effect.Success<ReturnType<typeof selectionOf>>, unknown>;
const readOriginal = (
	sql: SqlClient.SqlClient,
	proofId: string,
	current: Current,
): Effect.Effect<RemoteStore | null, unknown> =>
	Effect.gen(function* () {
		const rows = yield* sql`SELECT value FROM settings WHERE ${sql("key")}=${`restore-remote-before:${proofId}`}`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
		);
		if (!rows[0]) return null;
		const saved = yield* Schema.decodeEffect(Schema.fromJsonString(Selection))(rows[0].value, {
			onExcessProperty: "error",
		}).pipe(Effect.mapError(invalid));
		const now = yield* current;
		if (
			saved.engine !== now.selection.engine ||
			saved.endpoint !== now.selection.endpoint ||
			saved.store_id !== now.selection.store_id
		)
			return yield* invalid();
		return yield* withDatabase(now.store, saved.database);
	});
const blocked = (sql: SqlClient.SqlClient, current: Current) =>
	Effect.gen(function* () {
		const rows = yield* sql`SELECT proof_id FROM db_restore_requests WHERE phase='failed'`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ proof_id: Schema.String })))),
		);
		for (const row of rows) {
			const original = yield* readOriginal(sql, row.proof_id, current);
			if (original && original.database === (yield* current).store.database) return true;
		}
		return false;
	});

/** Boot-only startup/transfer preflight: a failed repair's original cannot become an active source.
 * Callers supply the resolved selection and confirmed boot identity before opening any app SQL scope. */
export const failedRemoteRestoreBlocksStartup = (sql: SqlClient.SqlClient, selected: RemoteStore, storeId: string) =>
	blocked(sql, selectionOf(selected, storeId));

/** The existing restore request owns this before-selection. It never opens the original database.
 * Record with phase=restoring in one boot transaction; native resource journals still own every target. */
export const remoteRestoreSelection = (recovery: AppRecovery["Service"]) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const current = Effect.gen(function* () {
			const status = yield* recovery.identityStatus;
			const store = yield* recovery.store;
			if (store._tag === "file" || status.adoption_phase !== "ready" || !status.app_store_id) return yield* invalid();
			return yield* selectionOf(store, status.app_store_id);
		});
		const read = (proofId: string) => readOriginal(sql, proofId, current);
		const record = (proofId: string) =>
			Effect.gen(function* () {
				if (Option.isNone(yield* Effect.serviceOption(sql.transactionService))) return yield* invalid();
				const now = yield* current;
				const previous = yield* read(proofId);
				if (previous) {
					if (previous.database !== now.store.database) return yield* invalid();
					return;
				}
				yield* sql`INSERT INTO settings(${sql("key")},value) VALUES(${`restore-remote-before:${proofId}`},${yield* Schema.encodeEffect(Schema.fromJsonString(Selection))(now.selection)})`;
			});
		return { current, record, read, blocksStartup: blocked(sql, current) };
	});
