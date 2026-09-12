import { indexShape } from "@comms/storage/remote-migrations";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Constructor } from "effect/unstable/sql/Statement";
import { KernelError } from "../../kernel/boot-channel.ts";

const folded = "SELECT public.unaccent('public.unaccent'::pg_catalog.regdictionary, value)";
const plain = "SELECT value";
const FunctionRows = Schema.Array(Schema.Struct({ body: Schema.String, valid: Schema.Boolean }));
/** Exact app-owned capability; existence alone never enables a caller-controlled function. */
export const postgresSearchMode = (sql: Constructor) =>
	Effect.gen(function* () {
		const rows =
			yield* sql`SELECT p.prosrc AS body,(p.prokind='f' AND NOT p.proretset AND p.pronargdefaults=0 AND p.pronargs=1 AND p.provolatile='i' AND NOT p.prosecdef AND p.prorettype=25 AND p.proargtypes='25'::pg_catalog.oidvector AND p.proconfig=ARRAY['search_path=pg_catalog'] AND l.lanname='sql') AS valid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname='comms_unaccent'`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(FunctionRows)),
			);
		if (rows.length === 0) return "absent" as const;
		if (rows.length !== 1 || !rows[0]?.valid || ![folded, plain].includes(rows[0].body))
			return yield* new KernelError({ code: "app_schema_unsupported" });
		if (rows[0].body === plain) return "plain" as const;
		const dependencies =
			yield* sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace JOIN pg_catalog.pg_ts_dict d ON d.dictnamespace=n.oid AND d.dictname='unaccent' JOIN pg_catalog.pg_ts_template t ON t.oid=d.dicttemplate WHERE e.extname='unaccent' AND n.nspname='public' AND t.tmplname='unaccent' AND d.dictinitoption=${"rules = 'unaccent'"} AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend x WHERE x.refobjid=e.oid AND x.classid='pg_proc'::pg_catalog.regclass AND x.objid=pg_catalog.to_regprocedure('public.unaccent(pg_catalog.regdictionary,text)') AND x.deptype='e') AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend x WHERE x.refobjid=e.oid AND x.classid='pg_ts_dict'::pg_catalog.regclass AND x.objid=d.oid AND x.deptype='e') AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend x WHERE x.refobjid=e.oid AND x.classid='pg_ts_template'::pg_catalog.regclass AND x.objid=t.oid AND x.deptype='e')) AS valid`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ valid: Schema.Boolean })]))),
			);
		if (!dependencies[0].valid) return yield* new KernelError({ code: "app_schema_unsupported" });
		return "folded" as const;
	});

const definitions = (sql: SqlClient) =>
	sql`SELECT a.attname AS name,replace(pg_catalog.pg_get_expr(d.adbin,d.adrelid),'public.','') AS expression FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.messages'::pg_catalog.regclass AND a.attname IN ('body_tsv','previous_body_tsv') AND a.attgenerated='s' ORDER BY a.attname`.pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String, expression: Schema.String }))),
		),
	);
export const postgresSearchShape = (sql: SqlClient) =>
	Effect.gen(function* () {
		const mode = yield* postgresSearchMode(sql);
		if (mode === "absent") return false;
		const wrap = (text: string) => (mode === "folded" ? `comms_unaccent(${text})` : text);
		const expected = [
			{ name: "body_tsv", expression: `to_tsvector('simple'::regconfig, ${wrap("COALESCE(body, ''::text)")})` },
			{
				name: "previous_body_tsv",
				expression: `to_tsvector('simple'::regconfig, ${wrap("COALESCE(((previous)::jsonb ->> 'body'::text), ''::text)")})`,
			},
		];
		return (
			JSON.stringify(yield* definitions(sql)) === JSON.stringify(expected) &&
			(yield* indexShape(sql, "messages", "messages_body_tsv", ["body_tsv"], false, "gin")) &&
			(yield* indexShape(sql, "messages", "messages_previous_body_tsv", ["previous_body_tsv"], false, "gin"))
		);
	});

/** PostgreSQL subtransactions classify only extension availability failures; other errors abort migration12. */
export const postgresSearchOperation = (sql: SqlClient) => ({
	name: "search_diacritics",
	postcondition: postgresSearchShape(sql),
	run: Effect.gen(function* () {
		// No IF NOT EXISTS for our function: never adopt or replace an unknown app object.
		yield* sql.unsafe(`DO $comms$
DECLARE available boolean := true;
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='unaccent' AND n.nspname='public') THEN
      RAISE EXCEPTION USING ERRCODE='0A000', MESSAGE='unaccent outside supported schema';
    END IF;
  EXCEPTION WHEN insufficient_privilege OR feature_not_supported OR undefined_file THEN
    available := false;
  END;
  IF available THEN
    EXECUTE $ddl$CREATE FUNCTION public.comms_unaccent(value text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $body$${folded}$body$$ddl$;
  ELSE
    EXECUTE $ddl$CREATE FUNCTION public.comms_unaccent(value text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $body$${plain}$body$$ddl$;
  END IF;
END $comms$`);
		if ((yield* postgresSearchMode(sql)) === "folded") {
			yield* sql`ALTER TABLE messages DROP COLUMN body_tsv, DROP COLUMN previous_body_tsv`;
			yield* sql`ALTER TABLE messages ADD COLUMN body_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',public.comms_unaccent(coalesce(body,'')))) STORED, ADD COLUMN previous_body_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',public.comms_unaccent(coalesce(previous::jsonb->>'body','')))) STORED`;
			yield* sql`CREATE INDEX messages_body_tsv ON messages USING gin(body_tsv)`;
			yield* sql`CREATE INDEX messages_previous_body_tsv ON messages USING gin(previous_body_tsv)`;
		}
	}),
});
