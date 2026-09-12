import {
	copyTransferTable,
	prepareTransferTable,
	scanTransferTable,
	type TransferTableManifest,
} from "@comms/storage/transfer-copy";
import type { TransferInventory } from "@comms/storage/transfer-inventory";
import { TransferRejected } from "@comms/storage/store-transfer-schema";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { logicalTransferPlan } from "./logical-plan.ts";
import type { TransferEngine, TransferStore } from "./derived-schema.ts";

const invalid = () => new TransferRejected({ code: "transfer_verification_failed" });
const same = (left: TransferTableManifest, right: TransferTableManifest) =>
	left.rows === right.rows &&
	left.digest === right.digest &&
	JSON.stringify(left.identities) === JSON.stringify(right.identities);

/** Domain controls have explicit transformations. Every other ordinary table stays in
 * the exhaustive logical plan. The caller prepares BOTH roles before invoking any copy. */
export const prepareTransferData = (options: {
	readonly store: TransferStore;
	readonly source: { readonly sql: SqlClient; readonly engine: TransferEngine; readonly inventory: TransferInventory };
	readonly target: { readonly sql: SqlClient; readonly engine: TransferEngine; readonly inventory: TransferInventory };
}) =>
	Effect.gen(function* () {
		const { source, target, store } = options;
		const plan = yield* logicalTransferPlan(options);
		const controls: readonly string[] = store === "boot" ? ["settings", "seq"] : ["store_identity", "kernel_writer"];
		if (controls.some((name) => !plan.tables.some((table) => table.name === name))) return yield* invalid();
		const assertEmptyJournals = Effect.gen(function* () {
			for (const side of ["source", "target"] as const) {
				const sql = options[side].sql;
				for (const table of plan.empty[side]) {
					if ((yield* sql`SELECT 1 FROM ${sql(table.name)} LIMIT 1`).length) return yield* invalid();
				}
			}
		});
		yield* assertEmptyJournals;
		const tables = yield* Effect.forEach(
			plan.tables.filter((table) => !controls.includes(table.name)),
			(table) =>
				Effect.gen(function* () {
					const shape = target.inventory.tables.find((entry) => entry.name === table.name);
					if (!shape) return yield* invalid();
					const manifest = yield* prepareTransferTable(source.sql, target.sql, table, shape);
					return { table, shape, manifest };
				}),
			{ concurrency: 1 },
		);
		const verify = Effect.gen(function* () {
			yield* assertEmptyJournals;
			for (const { table, shape, manifest } of tables) {
				if (
					!same(yield* scanTransferTable(source.sql, table, shape, target.engine), manifest) ||
					!same(yield* scanTransferTable(target.sql, table, shape, target.engine), manifest)
				)
					return yield* invalid();
			}
		});
		const copy = Effect.gen(function* () {
			yield* assertEmptyJournals;
			for (const { table, shape, manifest } of tables)
				yield* copyTransferTable(source.sql, target.sql, table, shape, manifest);
			yield* verify;
		});
		return {
			ledgers: plan.ledgers,
			manifest: { store, tables: tables.map(({ table, manifest }) => ({ table, ...manifest })) },
			copy,
			verify,
			assertEmptyJournals,
		};
	});
