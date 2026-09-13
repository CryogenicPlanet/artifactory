import { on } from "@comms/storage/dialect";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { mysqlMigrationTargets } from "./mysql-migration-targets.ts";
import { sqlTableTargets } from "./sql-table-targets.ts";
import { KernelError } from "./boot-channel.ts";
import { kernelSqlTables, protectedSqlTables, validProtectedTableName } from "./protected-sql-tables.ts";

const invalid = () => new KernelError({ code: "extension_migration_invalid" });
const identifier = `(?:"([a-zA-Z_][a-zA-Z0-9_]*)"|\`([a-zA-Z_][a-zA-Z0-9_]*)\`|([a-zA-Z_][a-zA-Z0-9_]*))`;
const nameOf = (match: RegExpExecArray | null, offset = 1) =>
	(match?.[offset] ?? match?.[offset + 1] ?? match?.[offset + 2])?.toLowerCase();
const exists = (sql: SqlClient.SqlClient, name: string) =>
	on(sql, {
		sqlite: () => sql`SELECT name FROM sqlite_schema WHERE type='table' AND lower(name)=${name}`,
		pg: () =>
			sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND lower(table_name)=${name}`,
		mysql: () =>
			sql`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND lower(TABLE_NAME)=${name}`,
	}).pipe(Effect.map((rows) => rows.length === 1));

/** Trusted editable migrations may explicitly release application registrations, including legacy owners. */
export const releaseProtectedTables = (sql: SqlClient.SqlClient, names: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		for (const name of names) {
			if (!validProtectedTableName(name) || kernelSqlTables.includes(name.toLowerCase())) return yield* invalid();
		}
		for (const name of names) yield* sql`DELETE FROM protected_sql_tables WHERE name=${name.toLowerCase()}`;
	});

/** Capture under the writer fence. The returned receipt runs only after the preserved operation succeeds. */
export const extensionProtection = (
	sql: SqlClient.SqlClient,
	extension: string,
	statement: string,
	unprotect?: string,
) =>
	Effect.gen(function* () {
		yield* protectedSqlTables(sql);
		const rows = yield* sql`SELECT name,extension FROM protected_sql_tables`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(Schema.Struct({ name: Schema.String, extension: Schema.NullOr(Schema.String) })),
				),
			),
		);
		const owned = rows.filter((row) => row.extension === extension).map((row) => row.name);
		const release = unprotect?.toLowerCase();
		if (
			release !== undefined &&
			(!validProtectedTableName(release) || !owned.includes(release) || kernelSqlTables.includes(release))
		)
			return yield* invalid();
		const dropped = nameOf(
			new RegExp(`^\\s*DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${identifier}\\s*$`, "i").exec(statement),
		);
		const renamed = new RegExp(
			`^\\s*ALTER\\s+TABLE\\s+${identifier}\\s+RENAME\\s+(?:(?:TO|AS)\\s+)?${identifier}\\s*$`,
			"i",
		).exec(statement);
		const from = nameOf(renamed);
		const to = nameOf(renamed, 4);
		if (from && to && owned.includes(from) && (kernelSqlTables.includes(to) || rows.some((row) => row.name === to)))
			return yield* invalid();
		const tables = [
			...new Set([...kernelSqlTables, ...rows.filter((row) => row.extension !== extension).map((row) => row.name)]),
		];
		const targets = [
			...sqlTableTargets(statement),
			...(yield* on(sql, {
				sqlite: () => Effect.succeed([]),
				pg: () => Effect.succeed([]),
				mysql: () => mysqlMigrationTargets(statement),
			})),
		];
		if (targets.some((table) => tables.includes(table))) return yield* invalid();
		if (
			/^\s*ALTER\s+TABLE\b[\s\S]*\bRENAME\s+(?!COLUMN\b|INDEX\b|KEY\b)/i.test(statement) &&
			targets.some((table) => owned.includes(table)) &&
			!from
		)
			return yield* invalid();
		if (/^\s*DROP\s+TABLE\b/i.test(statement) && targets.some((table) => owned.includes(table)) && !dropped)
			return yield* invalid();
		return {
			tables,
			receipt: Effect.gen(function* () {
				for (const name of owned) {
					if (yield* exists(sql, name)) continue;
					if (name === dropped)
						yield* sql`DELETE FROM protected_sql_tables WHERE name=${name} AND extension=${extension}`;
					else if (name === from && to && (yield* exists(sql, to)))
						yield* sql`UPDATE protected_sql_tables SET name=${to} WHERE name=${name} AND extension=${extension}`;
					else return yield* invalid();
				}
				if (release !== undefined) yield* releaseProtectedTables(sql, [release]);
			}),
		};
	});
