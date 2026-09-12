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

/** The existing restore request owns this before-selection. It never opens the original database.
 * Record with phase=restoring in one boot transaction; native resource journals still own every target. */
export const remoteRestoreSelection = (recovery: AppRecovery["Service"]) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const current = Effect.gen(function* () {
			const status = yield* recovery.identityStatus;
			const store = yield* recovery.store;
			if (store._tag === "file" || status.adoption_phase !== "ready" || !status.app_store_id) return yield* invalid();
			const endpoint = yield* Effect.try({
				try: () => {
					const url = new URL(Redacted.value(store.url));
					return `${url.hostname.toLowerCase()}:${url.port || (store._tag === "postgres" ? "5432" : "3306")}`;
				},
				catch: invalid,
			});
			return {
				store,
				selection: { engine: store._tag, endpoint, database: store.database, store_id: status.app_store_id },
			};
		});
		const read = (proofId: string): Effect.Effect<RemoteStore | null, unknown> =>
			Effect.gen(function* () {
				const rows =
					yield* sql`SELECT value FROM settings WHERE ${sql("key")}=${`restore-remote-before:${proofId}`}`.pipe(
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
		const blocksStartup = Effect.gen(function* () {
			const rows = yield* sql`SELECT proof_id FROM db_restore_requests WHERE phase='failed'`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ proof_id: Schema.String })))),
			);
			for (const row of rows) {
				const original = yield* read(row.proof_id);
				if (original && original.database === (yield* current).store.database) return true;
			}
			return false;
		});
		return { current, record, read, blocksStartup };
	});
