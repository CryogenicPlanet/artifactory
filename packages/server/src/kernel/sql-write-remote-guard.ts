import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";

const Names = Schema.Array(Schema.Struct({ name: Schema.String }));
const Texts = Schema.Array(Schema.Struct({ value: Schema.String }));
const Tables = Schema.Array(Schema.Struct({ schema: Schema.String, name: Schema.String, kind: Schema.String }));
const unsupported = () => new KernelError({ code: "sql_unsupported" });

/** This first repair slice intentionally accepts only a single unqualified target table. */
export const remoteWriteTarget = (text: string, dialect: "pg" | "mysql") =>
	Effect.gen(function* () {
		const match =
			/^(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"([a-zA-Z_][a-zA-Z0-9_]*)"|`([a-zA-Z_][a-zA-Z0-9_]*)`|([a-zA-Z_][a-zA-Z0-9_]*))\s*([\s\S]*)$/i.exec(
				text.trim(),
			);
		const name = match?.[2] ?? match?.[3] ?? match?.[4];
		const rest = match?.[5] ?? "";
		if (
			!match ||
			!name ||
			name.length > 128 ||
			!(match[1]?.toUpperCase() === "UPDATE"
				? /^SET\b/i.test(rest)
				: match[1]?.toUpperCase().startsWith("DELETE")
					? /^(?:WHERE\b|RETURNING\b|ORDER\b|LIMIT\b|$)/i.test(rest)
					: /^(?:\(|VALUES\b|DEFAULT\b|SELECT\b)/i.test(rest))
		)
			return yield* unsupported();
		return dialect === "pg" && match[4] ? name.toLowerCase() : name;
	});

/** Complete bounded images, never sampled rows: overflow refuses the repair before caller SQL. */
export const remoteWriteGuard = (
	sql: SqlClient.SqlClient,
	dialect: "pg" | "mysql",
	protectedTables: ReadonlyArray<string>,
	target: string,
) =>
	Effect.gen(function* () {
		if (dialect === "pg") yield* sql`SET LOCAL search_path TO pg_catalog, public, pg_temp`;
		const location = yield* (dialect === "pg" ? sql`SELECT 'public' AS name` : sql`SELECT DATABASE() AS name`).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Names)),
		);
		const schema = location[0]?.name;
		if (!schema || (dialect === "pg" && schema !== "public")) return yield* unsupported();
		const inventory = () =>
			(dialect === "pg"
				? sql`SELECT n.nspname AS schema,c.relname AS name,(c.relkind::text||':'||c.relpersistence::text) AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind NOT IN ('i','I','S','t') ORDER BY n.nspname,c.relname LIMIT 257`
				: sql`SELECT TABLE_SCHEMA AS \`schema\`,TABLE_NAME AS name,COALESCE(ENGINE,'VIEW') AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME LIMIT 257`
			).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Tables)));
		const tables = yield* inventory();
		if (
			tables.length > 256 ||
			tables.some((table) => table.schema !== schema || table.kind !== (dialect === "pg" ? "r:p" : "InnoDB")) ||
			!tables.some((table) => table.name === target)
		)
			return yield* unsupported();
		// Builtins and the known text-search extension are trusted; arbitrary custom executables are not part of this slice.
		const executable = yield* (
			dialect === "pg"
				? sql`SELECT p.proname AS name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e' AND e.extname='unaccent') LIMIT 1`
				: sql`SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA NOT IN ('mysql','sys','information_schema','performance_schema') LIMIT 1`
		).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Names)));
		const triggers = yield* (
			dialect === "pg"
				? sql`SELECT t.tgname AS name FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND NOT t.tgisinternal LIMIT 1`
				: sql`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() LIMIT 1`
		).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Names)));
		if (executable.length || triggers.length) return yield* unsupported();
		const guarded = tables.filter((table) => protectedTables.includes(table.name.toLowerCase()));
		const capture = () =>
			Effect.gen(function* () {
				const images: Array<string> = [];
				let rows = 0;
				let bytes = 0;
				for (const table of guarded) {
					const columns =
						yield* sql`SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema=${schema} AND table_name=${table.name} ORDER BY ordinal_position LIMIT 257`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Names)),
						);
					if (columns.length === 0 || columns.length > 256) return yield* unsupported();
					const definition = yield* (
						dialect === "pg"
							? sql`SELECT to_jsonb(a)::text AS value FROM pg_catalog.pg_attribute a WHERE a.attrelid=to_regclass(${schema + "." + '"' + table.name.replaceAll('"', '""') + '"'}) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`
							: sql`SELECT CAST(JSON_OBJECT('name',COLUMN_NAME,'type',COLUMN_TYPE,'nullable',IS_NULLABLE,'default',COLUMN_DEFAULT,'extra',EXTRA,'generation',GENERATION_EXPRESSION,'collation',COLLATION_NAME) AS CHAR) AS value FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=${schema} AND TABLE_NAME=${table.name} ORDER BY ORDINAL_POSITION`
					).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Texts)));
					const projection =
						dialect === "pg"
							? sql`to_jsonb(t)::text`
							: sql`CAST(JSON_OBJECT(${sql.join(",", false)(columns.map(({ name }) => sql`${name},t.${sql(name)}`))}) AS CHAR)`;
					// Measure on the server before transferring row images; a single giant retained event must refuse safely.
					const size =
						yield* sql`SELECT COUNT(*) AS row_count,COALESCE(SUM(OCTET_LENGTH(value)),0) AS bytes FROM (SELECT ${projection} AS value FROM ${sql(schema)}.${sql(table.name)} AS t LIMIT 1001) AS images`.pipe(
							Effect.flatMap(
								Schema.decodeUnknownEffect(
									Schema.Array(
										Schema.Struct({
											row_count: Schema.Int,
											bytes: Schema.Union([Schema.Int, Schema.NumberFromString]),
										}),
									),
								),
							),
						);
					if (!size[0] || size[0].row_count + rows > 1000 || size[0].bytes + bytes > 1048576)
						return yield* unsupported();
					const content =
						yield* sql`SELECT ${projection} AS value FROM ${sql(schema)}.${sql(table.name)} AS t LIMIT 1001`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Texts)),
						);
					rows += content.length;
					const image = JSON.stringify([
						table,
						definition.map(({ value }) => value),
						content.map(({ value }) => value).sort(),
					]);
					bytes += new TextEncoder().encode(image).byteLength;
					if (rows > 1000 || bytes > 1048576) return yield* unsupported();
					images.push(image);
				}
				return images;
			});
		if (dialect === "mysql") {
			// SHOW CREATE resolves temporary-table shadows that information_schema intentionally omits.
			for (const table of tables.filter(
				(table) => table.name === target || protectedTables.includes(table.name.toLowerCase()),
			)) {
				const ddl = yield* sql`SHOW CREATE TABLE ${sql(schema)}.${sql(table.name)}`.unprepared.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ "Create Table": Schema.String })))),
				);
				if (ddl.length !== 1 || /^CREATE TEMPORARY TABLE/i.test(ddl[0]?.["Create Table"] ?? ""))
					return yield* unsupported();
			}
		}
		const before = yield* capture();
		return Effect.gen(function* () {
			// Deferred FK actions must run before validation, never after it during COMMIT.
			if (dialect === "pg") {
				yield* sql`SET CONSTRAINTS ALL IMMEDIATE`;
				yield* sql`SET LOCAL search_path TO pg_catalog, public, pg_temp`;
			}
			if (
				JSON.stringify(yield* inventory()) !== JSON.stringify(tables) ||
				JSON.stringify(yield* capture()) !== JSON.stringify(before)
			)
				return yield* unsupported();
		});
	});
