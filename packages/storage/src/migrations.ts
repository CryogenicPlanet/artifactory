import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

export class MigrationLedgerError extends Schema.TaggedError<MigrationLedgerError>()("MigrationLedgerError", {
	code: Schema.Literals(["migration_ledger_invalid", "migration_ledger_too_new"]),
	ledger: Schema.Literals(["boot_migrations", "core_migrations"]),
}) {
	override get message() {
		return `${this.ledger}: ${this.code}`;
	}
}

/** The caller owns one transaction around adoption, every step, receipts and the user_version mirror.
 * SQLite only: editable and extension migration namespaces are deliberately independent. */
export const migrate = <E, R>(
	sql: SqlClient,
	ledger: "boot_migrations" | "core_migrations",
	version: number,
	steps: ReadonlyArray<{ readonly id: number; readonly name: string; readonly run: Effect.Effect<void, E, R> }>,
) =>
	Effect.gen(function* () {
		const invalid = () => new MigrationLedgerError({ code: "migration_ledger_invalid", ledger });
		if (
			!Number.isSafeInteger(version) ||
			version < 0 ||
			steps.length === 0 ||
			steps.some((step, index) => step.id !== index + 1 || !step.name)
		)
			return yield* invalid();
		if (version > steps.length) return yield* new MigrationLedgerError({ code: "migration_ledger_too_new", ledger });
		const tables = yield* sql`SELECT type FROM sqlite_master WHERE name=${ledger}`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ type: Schema.String })))),
		);
		if (tables.length > 1 || (tables[0] && tables[0].type !== "table")) return yield* invalid();
		const applied =
			tables.length === 0
				? []
				: yield* sql`SELECT migration_id,name FROM ${sql(ledger)} ORDER BY migration_id`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Array(Schema.Struct({ migration_id: Schema.Int, name: Schema.String })),
							),
						),
					);
		if (applied.some((row) => row.migration_id > steps.length))
			return yield* new MigrationLedgerError({ code: "migration_ledger_too_new", ledger });
		if (
			applied.some((row, index) => row.migration_id !== index + 1 || row.name !== steps[index]?.name) ||
			(tables.length > 0 && applied.length !== version)
		)
			return yield* invalid();
		if (tables.length === 0)
			yield* sql`CREATE TABLE ${sql(ledger)} (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`;
		for (const step of steps) {
			if (step.id <= applied.length) continue;
			if (step.id > version) yield* step.run;
			yield* sql`INSERT INTO ${sql(ledger)}(migration_id,name) VALUES(${step.id},${step.name})`;
		}
	});
