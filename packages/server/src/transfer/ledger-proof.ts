import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { validateExtensionLedger } from "./extension-ledger.ts";
import { TransferPlanError } from "./logical-plan.ts";

interface ExtensionProof {
	readonly extension: string;
	readonly name: string;
	readonly sourceChecksum: string;
	readonly targetChecksum: string;
}
interface Migration {
	readonly migration_id: number;
	readonly name: string;
}
export type LedgerProof =
	| { readonly name: "boot_migrations" | "core_migrations" | "migrations"; readonly rows: readonly Migration[] }
	| { readonly name: "extension_migrations"; readonly rows: readonly ExtensionProof[] };
const MigrationRows = Schema.Array(Schema.Struct({ migration_id: Schema.Int, name: Schema.String }));
const ExtensionRows = Schema.Array(
	Schema.Struct({ extension: Schema.String, name: Schema.String, checksum: Schema.String }),
);
const mismatch = (object: string) => new TransferPlanError({ code: "transfer_schema_mismatch", object });

/** Compare migration histories after exhaustive inventory and frozen target initialization.
 * The caller holds offline ownership throughout these reads and manifest verification.
 * Timestamps are intentionally excluded; no receipt is copied or rewritten. */
export const ledgerProof = (options: {
	readonly store: "boot" | "app";
	readonly source: SqlClient;
	readonly target: SqlClient;
	readonly ledgers: readonly { readonly name: string }[];
	readonly extensions: readonly ExtensionProof[];
}) =>
	Effect.gen(function* () {
		const required =
			options.store === "boot" ? (["boot_migrations"] as const) : (["core_migrations", "migrations"] as const);
		const names = options.ledgers.map((ledger) => ledger.name);
		const extension = names.includes("extension_migrations");
		if (
			new Set(names).size !== names.length ||
			required.some((name) => !names.includes(name)) ||
			names.some(
				(name) =>
					!required.some((required) => required === name) &&
					!(options.store === "app" && name === "extension_migrations"),
			) ||
			(options.store === "boot" && options.extensions.length > 0) ||
			(!extension && options.extensions.length > 0)
		)
			return yield* mismatch("migration_ledgers");
		const result: LedgerProof[] = [];
		for (const name of required) {
			const read = (sql: SqlClient) =>
				sql`SELECT migration_id,name FROM ${sql(name)}`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(MigrationRows)),
					Effect.mapError(() => mismatch(name)),
					Effect.flatMap((rows) => {
						if (
							rows.some((row) => !Number.isSafeInteger(row.migration_id) || row.migration_id < 1) ||
							new Set(rows.map((row) => row.migration_id)).size !== rows.length
						)
							return Effect.fail(mismatch(name));
						return Effect.succeed(rows.toSorted((a, b) => a.migration_id - b.migration_id));
					}),
				);
			const source = yield* read(options.source);
			const target = yield* read(options.target);
			if (
				source.length !== target.length ||
				source.some(
					(row, index) => row.migration_id !== target[index]?.migration_id || row.name !== target[index]?.name,
				)
			)
				return yield* mismatch(name);
			result.push({ name, rows: source });
		}
		if (extension) {
			const read = (sql: SqlClient) =>
				sql`SELECT extension,name,checksum FROM extension_migrations`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(ExtensionRows)),
					Effect.mapError(() => mismatch("extension_migrations")),
				);
			const source = yield* read(options.source);
			const target = yield* read(options.target);
			result.push({
				name: "extension_migrations",
				rows: yield* validateExtensionLedger(source, target, options.extensions),
			});
		}
		const canonical: readonly LedgerProof[] = result.toSorted((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		return canonical;
	});
