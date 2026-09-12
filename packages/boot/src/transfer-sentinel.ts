import { on } from "@comms/storage/dialect";
import { TransferRejected, type TransferSelection } from "@comms/storage/store-transfer-schema";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { remoteAppKernelOperations } from "./app-kernel-schema.ts";
import { decodeRows } from "./decode-rows.ts";

export const sqliteTransferIdentity =
	"CREATE TABLE store_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id TEXT NOT NULL,initialized_at INTEGER NOT NULL,transferred_to TEXT)";
const rejected = () => new TransferRejected({ code: "transfer_journal_conflict" });
export const transferSentinelMarker = (selection: TransferSelection) => `transfer:${selection.transfer_id}`;
export const assertTransferSentinel = (
	app: SqlClient.SqlClient,
	selection: TransferSelection,
	seed: { readonly initialized_at: number },
	allowCleared = false,
) =>
	Effect.gen(function* () {
		const rows = yield* app`SELECT singleton,store_id,initialized_at,transferred_to FROM store_identity`.pipe(
			decodeRows(
				Schema.Struct({
					singleton: Schema.Int,
					store_id: Schema.String,
					initialized_at: Schema.Int,
					transferred_to: Schema.NullOr(Schema.String),
				}),
			),
		);
		const row = rows[0];
		if (
			rows.length !== 1 ||
			!row ||
			row.singleton !== 1 ||
			row.store_id !== selection.store_id ||
			row.initialized_at !== seed.initialized_at ||
			(row.transferred_to !== transferSentinelMarker(selection) && !(allowCleared && row.transferred_to === null))
		)
			return yield* rejected();
	});

/** Caller has durably reserved this exact empty target in the preparation journal. This is
 * the FIRST target DDL. Even a committed empty table makes historical ordinary adoption refuse. */
export const reserveTransferSentinel = (
	app: SqlClient.SqlClient,
	principal: string,
	selection: TransferSelection,
	seed: { readonly initialized_at: number },
) =>
	Effect.gen(function* () {
		const objects = yield* on(app, {
			sqlite: () => app`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`,
			pg: () =>
				app`SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT starts_with(n.nspname::text,'pg_toast') AND NOT starts_with(n.nspname::text,'pg_temp_') AND c.relkind IN ('r','p','v','m','f')`,
			mysql: () => app`SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE()`,
		}).pipe(decodeRows(Schema.Struct({ name: Schema.String })));
		if (objects.some((object) => object.name !== "store_identity") || objects.length > 1) return yield* rejected();
		if (on(app, { sqlite: () => true, pg: () => false, mysql: () => false })) {
			yield* app`PRAGMA synchronous = FULL`;
			if (objects.length === 0) yield* app.unsafe(sqliteTransferIdentity);
			const shape = yield* app`SELECT sql FROM sqlite_master WHERE type='table' AND name='store_identity'`.pipe(
				decodeRows(Schema.Struct({ sql: Schema.String })),
			);
			if (shape.length !== 1 || shape[0]?.sql !== sqliteTransferIdentity) return yield* rejected();
		} else {
			const identity = remoteAppKernelOperations(app, principal).find(
				(operation) => operation.name === "table:store_identity",
			);
			if (!identity) return yield* rejected();
			if (objects.length === 0) yield* identity.run;
			if (!(yield* identity.postcondition)) return yield* rejected();
		}
		const existing = yield* app`SELECT singleton FROM store_identity`;
		if (existing.length === 0)
			yield* app`INSERT INTO store_identity(singleton,store_id,initialized_at,transferred_to) VALUES(1,${selection.store_id},${seed.initialized_at},${transferSentinelMarker(selection)})`;
		yield* assertTransferSentinel(app, selection, seed);
	});
