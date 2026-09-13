import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import { preserveRemoteMigrationState } from "./migration-state-remote.ts";
import { kernelSqlTables } from "./protected-sql-tables.ts";

const Objects = Schema.Array(
	Schema.Struct({
		type: Schema.String,
		name: Schema.String,
		tbl_name: Schema.String,
		sql: Schema.NullOr(Schema.String),
	}),
);

/** Caller holds the migration transaction. Product and extension-owned tables remain editable. */
export const preserveMigrationState = <A, E, R>(
	sql: SqlClient.SqlClient,
	operation: Effect.Effect<A, E, R>,
	tables: ReadonlyArray<string> = kernelSqlTables,
) =>
	Effect.gen(function* () {
		if (!sql.onDialectOrElse({ sqlite: () => true, orElse: () => false }))
			return yield* preserveRemoteMigrationState(sql, operation);
		const inventory =
			sql`SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE lower(tbl_name) IN ${sql.in(tables)} ORDER BY type,name`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Objects)),
			);
		const temporary =
			sql`SELECT type,name,tbl_name,sql FROM temp.sqlite_schema WHERE lower(name) IN ${sql.in(tables)} OR lower(tbl_name) IN ${sql.in(tables)} ORDER BY type,name`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Objects)),
			);
		if ((yield* temporary).length) return yield* new KernelError({ code: "extension_migration_invalid" });
		const before = yield* inventory;
		const guards: Array<string> = [];
		for (const table of before.filter(({ type }) => type === "table")) {
			for (const action of ["INSERT", "UPDATE", "DELETE"]) {
				const name = `comms_migration_guard_${table.name}_${action}`;
				yield* sql.unsafe(
					`CREATE TEMP TRIGGER ${name} BEFORE ${action} ON main.${table.name} BEGIN SELECT RAISE(ABORT,'reserved migration bookkeeping'); END`,
				);
				guards.push(name);
			}
		}
		const installed = yield* temporary;
		const result = yield* operation;
		if (
			JSON.stringify(yield* inventory) !== JSON.stringify(before) ||
			JSON.stringify(yield* temporary) !== JSON.stringify(installed)
		)
			return yield* new KernelError({ code: "extension_migration_invalid" });
		for (const name of guards) yield* sql`DROP TRIGGER temp.${sql(name)}`;
		return result;
	});
