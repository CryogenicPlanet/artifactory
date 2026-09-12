import { createHash } from "node:crypto";
import { Effect, Schema, Stream } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import { kernelSqlTables } from "./protected-sql-tables.ts";

const Names = Schema.Array(Schema.Struct({ name: Schema.String }));
const Text = Schema.Struct({ value: Schema.String });
const invalid = () => new KernelError({ code: "extension_migration_invalid" });

/** Detect changes before PostgreSQL commit or MySQL intent clearance. MySQL DDL is not rolled back.
 * Migration modules remain trusted code: a separate connection or explicit commit can escape this check. */
export const preserveRemoteMigrationState = <A, E, R>(sql: SqlClient.SqlClient, operation: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const pg = sql.onDialectOrElse({ pg: () => true, orElse: () => false });
		const capture = Effect.gen(function* () {
			if (pg) {
				yield* sql`SET LOCAL search_path TO public, pg_temp`;
				const shadows =
					yield* sql`SELECT c.relname FROM pg_catalog.pg_class c WHERE c.relnamespace=pg_my_temp_schema() AND lower(c.relname) IN ${sql.in(kernelSqlTables)}`;
				if (shadows.length) return yield* invalid();
			}
			const tables = yield* (
				pg
					? sql`SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND lower(c.relname) IN ${sql.in(kernelSqlTables)} ORDER BY c.relname`
					: sql`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND lower(TABLE_NAME) IN ${sql.in(kernelSqlTables)} ORDER BY TABLE_NAME`
			).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Names)));
			const hash = createHash("sha256");
			const add = (value: string) => {
				hash.update(String(Buffer.byteLength(value)));
				hash.update(":");
				hash.update(value);
			};
			for (const { name } of tables) {
				add(name);
				if (pg) {
					const definitions = yield* sql`SELECT value FROM (
 SELECT 'relation:'||jsonb_build_array(c.relkind,c.relpersistence,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.reloptions)::text AS value FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name}
 UNION ALL SELECT 'column:'||to_jsonb(a)::text FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name} AND a.attnum>0
 UNION ALL SELECT 'default:'||pg_get_expr(d.adbin,d.adrelid) FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_class c ON c.oid=d.adrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name}
 UNION ALL SELECT 'constraint:'||pg_get_constraintdef(k.oid)||':'||k.convalidated::text FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name}
 UNION ALL SELECT 'index:'||pg_get_indexdef(i.indexrelid) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name}
 UNION ALL SELECT 'trigger:'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name}
 UNION ALL SELECT 'rule:'||pg_get_ruledef(r.oid) FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name}
 UNION ALL SELECT 'policy:'||to_jsonb(p)::text FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name}
) AS definitions ORDER BY value COLLATE "C"`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Text))));
					for (const { value } of definitions) add(value);
				} else {
					const ddl = yield* sql`SHOW CREATE TABLE ${sql(name)}`.unprepared.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ "Create Table": Schema.String })))),
					);
					if (ddl.length !== 1 || /^CREATE TEMPORARY TABLE/i.test(ddl[0]?.["Create Table"] ?? ""))
						return yield* invalid();
					add(ddl[0]?.["Create Table"] ?? "");
					const triggers =
						yield* sql`SELECT CAST(JSON_OBJECT('name',TRIGGER_NAME,'event',EVENT_MANIPULATION,'timing',ACTION_TIMING,'order',ACTION_ORDER,'body',ACTION_STATEMENT,'definer',DEFINER,'mode',SQL_MODE,'charset',CHARACTER_SET_CLIENT,'collation',COLLATION_CONNECTION,'database_collation',DATABASE_COLLATION) AS CHAR) AS value FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=${name} ORDER BY TRIGGER_NAME`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Text))),
						);
					for (const { value } of triggers) add(value);
				}
				const columns =
					yield* sql`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=${pg ? "public" : sql`DATABASE()`} AND TABLE_NAME=${name} ORDER BY ORDINAL_POSITION`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Names)),
					);
				const projection = pg
					? sql`to_jsonb(t)::text`
					: sql`CAST(JSON_OBJECT(${sql.join(",", false)(columns.map(({ name }) => sql`${name},t.${sql(name)}`))}) AS CHAR)`;
				const rows = sql`SELECT value FROM (SELECT ${projection} AS value FROM ${pg ? sql`public.${sql(name)}` : sql`${sql(name)}`} AS t) AS images ORDER BY ${pg ? sql`value COLLATE "C"` : sql`BINARY value`}`;
				// Stream every row in a deterministic order, without retaining images or imposing a board-size ceiling.
				yield* rows.stream.pipe(
					Stream.mapEffect((row) => Schema.decodeUnknownEffect(Text)(row)),
					Stream.runForEach(({ value }) => Effect.sync(() => add(value))),
				);
			}
			return hash.digest("hex");
		});
		const before = yield* capture;
		const result = yield* operation;
		if (pg) yield* sql`SET CONSTRAINTS ALL IMMEDIATE`;
		if ((yield* capture) !== before) return yield* invalid();
		return result;
	});
