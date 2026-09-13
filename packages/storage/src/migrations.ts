import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

export class MigrationLedgerError extends Schema.TaggedError<MigrationLedgerError>()("MigrationLedgerError", {
	code: Schema.Literals([
		"migration_steps_invalid",
		"migration_mirror_invalid",
		"migration_ledger_object_invalid",
		"migration_ledger_shape_invalid",
		"migration_ledger_id_invalid",
		"migration_ledger_name_mismatch",
		"migration_mirror_ahead",
		"migration_ledger_too_new",
	]),
	ledger: Schema.Literals(["boot_migrations", "core_migrations"]),
	position: Schema.optionalKey(Schema.Int),
	expected: Schema.optionalKey(Schema.Int),
	found: Schema.optionalKey(Schema.Int),
}) {
	override get message() {
		return `${this.ledger}: ${this.code}${this.position === undefined ? "" : ` at ${this.position}`}${this.expected === undefined ? "" : ` expected ${this.expected}`}${this.found === undefined ? "" : ` found ${this.found}`}`;
	}
}

type Ledger = "boot_migrations" | "core_migrations";
interface Step<E, R> {
	readonly id: number;
	readonly name: string;
	readonly run: Effect.Effect<void, E, R>;
}

/** Read-only preflight before journal-mode changes. A valid ledger is authoritative;
 * user_version is used only to adopt a store that has no ledger yet. */
export const inspectMigrations = <E, R>(sql: SqlClient, ledger: Ledger, steps: ReadonlyArray<Step<E, R>>) =>
	Effect.gen(function* () {
		if (!Array.isArray(steps) || steps.length === 0)
			return yield* new MigrationLedgerError({ code: "migration_steps_invalid", ledger });
		for (const [index, step] of steps.entries()) {
			if (
				typeof step !== "object" ||
				step === null ||
				step.id !== index + 1 ||
				typeof step.name !== "string" ||
				step.name.length === 0 ||
				step.name.length > 255 ||
				steps.slice(0, index).some((prior) => prior.name === step.name) ||
				!Effect.isEffect(step.run)
			)
				return yield* new MigrationLedgerError({ code: "migration_steps_invalid", ledger, position: index + 1 });
		}
		const versions = yield* sql`PRAGMA user_version`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ user_version: Schema.Int })))),
			Effect.mapError(() => new MigrationLedgerError({ code: "migration_mirror_invalid", ledger })),
		);
		const mirror = versions[0]?.user_version;
		if (versions.length !== 1 || mirror === undefined || !Number.isSafeInteger(mirror) || mirror < 0)
			return yield* new MigrationLedgerError({ code: "migration_mirror_invalid", ledger });
		if (mirror > steps.length)
			return yield* new MigrationLedgerError({
				code: "migration_ledger_too_new",
				ledger,
				expected: steps.length,
				found: mirror,
			});
		const tables = yield* sql`SELECT type FROM sqlite_master WHERE name=${ledger}`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ type: Schema.String })))),
		);
		if (tables.length > 1 || (tables[0] && tables[0].type !== "table"))
			return yield* new MigrationLedgerError({ code: "migration_ledger_object_invalid", ledger });
		if (tables.length === 0) return { version: mirror, mirror, exists: false };
		const applied = yield* sql`SELECT migration_id,name FROM ${sql(ledger)} ORDER BY migration_id`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ migration_id: Schema.Int, name: Schema.String }))),
			),
			Effect.mapError(() => new MigrationLedgerError({ code: "migration_ledger_shape_invalid", ledger })),
		);
		for (const [index, row] of applied.entries()) {
			if (row.migration_id > steps.length)
				return yield* new MigrationLedgerError({
					code: "migration_ledger_too_new",
					ledger,
					expected: steps.length,
					found: row.migration_id,
				});
			if (row.migration_id !== index + 1)
				return yield* new MigrationLedgerError({
					code: "migration_ledger_id_invalid",
					ledger,
					position: index + 1,
					expected: index + 1,
					found: row.migration_id,
				});
			if (row.name !== steps[index]?.name)
				return yield* new MigrationLedgerError({ code: "migration_ledger_name_mismatch", ledger, position: index + 1 });
		}
		if (mirror > applied.length)
			return yield* new MigrationLedgerError({
				code: "migration_mirror_ahead",
				ledger,
				expected: applied.length,
				found: mirror,
			});
		return { version: applied.length, mirror, exists: true };
	});

/** Adoption, pending steps, receipts and the derived mirror share one transaction.
 * An enclosing caller transaction also includes its own schema-shape checks. */
export const migrate = <E, R>(sql: SqlClient, ledger: Ledger, steps: ReadonlyArray<Step<E, R>>) =>
	sql.withTransaction(
		Effect.gen(function* () {
			const state = yield* inspectMigrations(sql, ledger, steps);
			if (!state.exists)
				yield* sql`CREATE TABLE ${sql(ledger)} (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`;
			for (const step of steps) {
				if (state.exists && step.id <= state.version) continue;
				if (step.id > state.version) yield* step.run;
				yield* sql`INSERT INTO ${sql(ledger)}(migration_id,name) VALUES(${step.id},${step.name})`;
			}
			// SQLite PRAGMA assignments cannot bind parameters. The validated array length is an integer.
			if (state.mirror !== steps.length) yield* sql.unsafe(`PRAGMA user_version = ${steps.length}`);
		}),
	);
