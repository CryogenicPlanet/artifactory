import {
	TransferRejected,
	selectionText,
	validateTransferSelection,
	type TransferSelection,
} from "@comms/storage/store-transfer-schema";
import type { TransferTablePlan } from "@comms/storage/transfer-copy";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

const protectedTables = ["store_identity", "kernel_writer", "outbox", "mutation_batches"] as const;
const nonDataTables = [
	"boot_migrations",
	"core_migrations",
	"migrations",
	"extension_migrations",
	"boot_migrations_intent",
	"core_migrations_intent",
	"kernel_migration_intent",
] as const;
const invalid = () => new TransferRejected({ code: "transfer_journal_conflict" });

/** The trusted caller supplies the exhaustive app plan from logicalTransferPlan: migrations,
 * catalog/trigger checks and acyclic FK ordering have already passed under exclusive ownership.
 * This is preparation-only cleanup, never a way to reset a partially copied target. A retry
 * requires the same preparation and still no final data-manifest journal. There is no source client.
 */
export const clearTransferSeeds = (
	targetBoot: SqlClient,
	targetApp: SqlClient,
	input: TransferSelection,
	reviewedAppPlan: { readonly store: "app"; readonly tables: readonly TransferTablePlan[] },
) =>
	Effect.gen(function* () {
		const selection = yield* validateTransferSelection(input);
		const names = reviewedAppPlan.tables.map((table) => table.name);
		if (
			reviewedAppPlan.store !== "app" ||
			new Set(names).size !== names.length ||
			protectedTables.some((name) => !names.includes(name)) ||
			names.some((name) => name.length === 0 || nonDataTables.some((reserved) => name === reserved))
		) {
			return yield* new TransferRejected({ code: "transfer_binding_invalid" });
		}
		const authorize = Effect.gen(function* () {
			const rows =
				yield* targetBoot`SELECT ${targetBoot("key")},value FROM settings WHERE ${targetBoot("key")} IN ('transfer_prepare','transfer_state','transfer_journal','transferred_to')`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
					),
				);
			if (
				rows.length !== 2 ||
				rows.find((row) => row.key === "transfer_prepare")?.value !== selectionText(selection) ||
				rows.find((row) => row.key === "transfer_state")?.value !== "in_progress"
			)
				return yield* invalid();
		});
		yield* authorize;
		// Never query either store inside the other store's transaction.
		yield* targetApp.withTransaction(
			Effect.gen(function* () {
				for (const name of [...names].reverse()) {
					if (!protectedTables.some((protectedName) => name === protectedName)) {
						yield* targetApp`DELETE FROM ${targetApp(name)}`;
					}
				}
			}),
		);
		yield* authorize;
	});
