import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "./dialect.ts";
import { inspectRemoteColumns } from "./schema-shape.ts";
import { sqliteTransferInventory } from "./transfer-sqlite.ts";
import {
	TransferInventoryError,
	type TransferColumn,
	type TransferDerivedObject,
	type TransferInventory,
	type TransferTable,
} from "./transfer-schema.ts";
const named = Schema.Array(Schema.Struct({ name: Schema.String }));
const foreignRows = Schema.Array(
	Schema.Struct({
		name: Schema.String,
		column: Schema.String,
		table: Schema.String,
		target: Schema.String,
		position: Schema.Int,
		local: Schema.Int,
	}),
);
const invalid = (object: string) => new TransferInventoryError({ code: "transfer_catalog_invalid", object });
const unsupported = (object: string) => new TransferInventoryError({ code: "transfer_object_unsupported", object });

/** Caller holds offline closure and a stable read transaction. No schema/data is created or changed.
 * Tables are discovered from catalogs, including custom tables; migration ledgers are not exclusions.
 * FK names identify groups only: compare ordered columns and targets across engines, never names. */
export const transferInventory = (
	sql: SqlClient,
	derived: ReadonlyArray<TransferDerivedObject> = [],
): Effect.Effect<TransferInventory, TransferInventoryError> =>
	Effect.gen(function* () {
		const engine = on(sql, { sqlite: () => "sqlite", pg: () => "pg", mysql: () => "mysql" });
		if (engine === "sqlite") return yield* sqliteTransferInventory(sql, derived);
		if (derived.length !== 0) return yield* unsupported(derived[0]?.name ?? "derived");
		const executable = yield* on(sql, {
			sqlite: () => sql`SELECT 1 WHERE 0`,
			pg: () => sql`SELECT p.proname AS name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
 UNION ALL SELECT t.tgname AS name FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
 UNION ALL SELECT pol.polname AS name FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid=pol.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
 UNION ALL SELECT evtname AS name FROM pg_catalog.pg_event_trigger
 UNION ALL SELECT r.rulename AS name FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND r.rulename<>'_RETURN'
 UNION ALL SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjsubid>0 AND d.deptype IN ('a','i'))
 UNION ALL SELECT c.relname AS name FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND i.indexprs IS NOT NULL`,
			mysql: () => sql`SELECT ROUTINE_NAME AS name FROM information_schema.routines WHERE ROUTINE_SCHEMA=DATABASE()
 UNION ALL SELECT TRIGGER_NAME AS name FROM information_schema.triggers WHERE TRIGGER_SCHEMA=DATABASE()
 UNION ALL SELECT EVENT_NAME AS name FROM information_schema.events WHERE EVENT_SCHEMA=DATABASE()
 UNION ALL SELECT INDEX_NAME AS name FROM information_schema.statistics WHERE TABLE_SCHEMA=DATABASE() AND EXPRESSION IS NOT NULL`,
		}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(named)));
		if (executable[0]) return yield* unsupported(executable[0].name);
		const tables = yield* on(sql, {
			sqlite: () => sql`SELECT 1 WHERE 0`,
			pg: () =>
				sql`SELECT c.relname AS name,CASE WHEN n.nspname='public' AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits h WHERE h.inhrelid=c.oid OR h.inhparent=c.oid) THEN 1 ELSE 0 END AS ordinary FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`,
			mysql: () =>
				sql`SELECT TABLE_NAME AS name,CASE WHEN TABLE_TYPE='BASE TABLE' AND ENGINE='InnoDB' AND NOT EXISTS(SELECT 1 FROM information_schema.partitions p WHERE p.TABLE_SCHEMA=t.TABLE_SCHEMA AND p.TABLE_NAME=t.TABLE_NAME AND p.PARTITION_NAME IS NOT NULL) THEN 1 ELSE 0 END AS ordinary FROM information_schema.tables t WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`,
		}).pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String, ordinary: Schema.Int }))),
			),
		);
		const result: TransferTable[] = [];
		for (const table of tables) {
			if (table.ordinary !== 1 || result.some((item) => item.name === table.name))
				return yield* unsupported(table.name);
			const raw = yield* inspectRemoteColumns(sql, table.name);
			if (!raw.length) return yield* invalid(table.name);
			const physical = yield* on(sql, {
				sqlite: () => sql`SELECT 1 WHERE 0`,
				pg: () =>
					sql`SELECT a.attname AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS declaration,CASE WHEN typ.typtype='b' AND tn.nspname='pg_catalog' THEN 1 ELSE 0 END AS supported FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_type typ ON typ.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=typ.typnamespace WHERE n.nspname='public' AND c.relname=${table.name} AND a.attnum>0 AND NOT a.attisdropped`,
				mysql: () =>
					sql`SELECT COLUMN_NAME AS name,COLUMN_TYPE AS declaration,CASE WHEN COLUMN_TYPE LIKE '%unsigned%' THEN 0 ELSE 1 END AS supported FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table.name}`,
			}).pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Array(Schema.Struct({ name: Schema.String, declaration: Schema.String, supported: Schema.Int })),
					),
				),
			);
			if (
				raw.length !== physical.length ||
				new Set(raw.map((column) => column.name)).size !== raw.length ||
				physical.some((column) => !raw.some((entry) => entry.name === column.name))
			)
				return yield* invalid(table.name);
			const columns: TransferColumn[] = [];
			for (const column of raw) {
				const type = column.type.toLowerCase();
				const generated = column.expression !== null && column.expression !== "";
				const facet = physical.find((item) => item.name === column.name);
				if (!facet) return yield* invalid(`${table.name}.${column.name}`);
				const kind =
					facet.supported !== 1
						? "unsupported"
						: /^(tinyint|smallint|mediumint|int|integer|bigint)$/.test(type)
							? "integer"
							: /^(real|double|double precision|float)$/.test(type)
								? "real"
								: /^(text|character varying|character|varchar|char|tinytext|mediumtext|longtext)$/.test(type)
									? "text"
									: /^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary)$/.test(type)
										? "bytes"
										: "unsupported";

				columns.push({
					name: column.name,
					type: column.type,
					declaration: facet.declaration,
					kind,
					nullable: column.nullable === "YES",
					generated,
					identity: column.identity === "YES" || (engine === "pg" && /^nextval\(/.test(column.default ?? "")),
					identityGeneration: column.identityGeneration,
					expression: column.expression,
					default: column.default,
					collation: column.collation,
					...(column.length === null ? {} : { length: column.length }),
				});
			}
			const keys = yield* on(sql, {
				sqlite: () => sql`SELECT 1 WHERE 0`,
				pg: () =>
					sql`SELECT a.attname AS name FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,position) ON true JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum WHERE n.nspname='public' AND c.relname=${table.name} AND i.indisprimary AND k.position<=i.indnkeyatts ORDER BY k.position`,
				mysql: () =>
					sql`SELECT COLUMN_NAME AS name FROM information_schema.statistics WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table.name} AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX`,
			}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(named)));
			const foreign = yield* on(sql, {
				sqlite: () => sql`SELECT 1 WHERE 0`,
				pg: () =>
					sql`SELECT c.conname AS name,a.attname AS "column",target.relname AS "table",ta.attname AS target,k.position::integer AS position,CASE WHEN tn.nspname='public' AND c.convalidated THEN 1 ELSE 0 END AS local FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace JOIN pg_catalog.pg_class target ON target.oid=c.confrelid JOIN pg_catalog.pg_namespace tn ON tn.oid=target.relnamespace JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY k(source,target,position) ON true JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.source JOIN pg_catalog.pg_attribute ta ON ta.attrelid=target.oid AND ta.attnum=k.target WHERE n.nspname='public' AND t.relname=${table.name} AND c.contype='f' ORDER BY c.conname,k.position`,
				mysql: () =>
					sql`SELECT CONSTRAINT_NAME AS name,COLUMN_NAME AS ${sql("column")},REFERENCED_TABLE_NAME AS ${sql("table")},REFERENCED_COLUMN_NAME AS target,ORDINAL_POSITION AS position,CASE WHEN REFERENCED_TABLE_SCHEMA=DATABASE() THEN 1 ELSE 0 END AS ${sql("local")} FROM information_schema.key_column_usage WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table.name} AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME,ORDINAL_POSITION`,
			}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(foreignRows)));
			const foreignKeys = [];
			for (const name of new Set(foreign.map((row) => row.name))) {
				const parts = foreign.filter((row) => row.name === name);
				const first = parts[0];
				if (
					!first ||
					parts.some((part, index) => part.local !== 1 || part.table !== first.table || part.position !== index + 1)
				)
					return yield* unsupported(`${table.name}.${name}`);
				foreignKeys.push({
					name,
					table: first.table,
					columns: parts.map((part) => part.column),
					targets: parts.map((part) => part.target),
				});
			}
			result.push({ name: table.name, columns, primaryKey: keys.map((key) => key.name), foreignKeys });
		}
		for (const table of result)
			for (const key of table.foreignKeys) {
				const target = result.find((row) => row.name === key.table);
				if (!target || !key.targets.every((name) => target.columns.some((column) => column.name === name)))
					return yield* invalid(`${table.name}.${key.name}`);
			}
		return { tables: result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), derived: [] };
	}).pipe(Effect.mapError((error) => (Schema.is(TransferInventoryError)(error) ? error : invalid("catalog"))));

export { TransferInventoryError } from "./transfer-schema.ts";
export type {
	TransferColumn,
	TransferTable,
	TransferForeignKey,
	TransferDerivedObject,
	TransferInventory,
} from "./transfer-schema.ts";
