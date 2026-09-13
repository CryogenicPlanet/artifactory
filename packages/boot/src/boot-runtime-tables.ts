import { bootTable, column, hashColumn } from "./boot-table-definition.ts";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

export const runtimeTables = (sql: SqlClient, engine: "pg" | "mysql") => [
	bootTable(
		sql,
		engine,
		1,
		"generations",
		[
			column("n", "integer", false, { identity: true }),
			column("snapshot_dir", "text", true),
			column("entry_file", "text", false),
			column("status", 16, false, {
				suffix: [
					" CHECK (\"status\" IN ('starting','live','failed','retired'))",
					" CHECK (`status` IN ('starting','live','failed','retired'))",
				],
			}),
			column("good", "integer", false, {
				defaults: ["0", "0"],
				suffix: [' DEFAULT 0 CHECK ("good" IN (0,1))', " DEFAULT 0 CHECK (`good` IN (0,1))"],
			}),
			column("stderr", "text", false, {
				defaults: ["''::text", "_utf8mb4\\'\\'"],
				suffix: [" DEFAULT ''", " DEFAULT ('')"],
			}),
			column("error", "text", true),
			column("started_at", "integer", false),
			column("healthy_at", "integer", true),
			column("retired_at", "integer", true),
			column("backup_id", 128, true),
		],
		["n"],
		['PRIMARY KEY ("n")', "PRIMARY KEY (`n`)"],
		[
			{
				foreignKeys: [],
				checks: [
					"(good = ANY (ARRAY[(0)::bigint, (1)::bigint]))",
					"(status = ANY (ARRAY['starting'::text, 'live'::text, 'failed'::text, 'retired'::text]))",
				],
			},
			{
				foreignKeys: [],
				checks: [
					"(`status` in (_utf8mb4\\'starting\\',_utf8mb4\\'live\\',_utf8mb4\\'failed\\',_utf8mb4\\'retired\\'))",
					"(`good` in (0,1))",
				],
			},
		],
		[],
	),
	bootTable(
		sql,
		engine,
		2,
		"settings",
		[column("key", 128, false), column("value", "text", false)],
		["key"],
		['PRIMARY KEY ("key")', "PRIMARY KEY (`key`)"],
		[
			{ foreignKeys: [], checks: [] },
			{ foreignKeys: [], checks: [] },
		],
		[],
	),
	bootTable(
		sql,
		engine,
		9,
		"child_attempts",
		[
			column("id", 128, false),
			column("generation", "integer", false),
			column("receipt", "text", false),
			column("opened", "integer", false, { defaults: ["0", "0"], suffix: [" DEFAULT 0", " DEFAULT 0"] }),
			column("closed", "integer", false, { defaults: ["0", "0"], suffix: [" DEFAULT 0", " DEFAULT 0"] }),
			column("boot_id", 128, true),
		],
		["id"],
		['PRIMARY KEY ("id")', "PRIMARY KEY (`id`)"],
		[
			{ foreignKeys: [], checks: [] },
			{ foreignKeys: [], checks: [] },
		],
		[],
	),
	bootTable(
		sql,
		engine,
		9,
		"backups",
		[
			column("id", 128, false),
			column("path", "text", false),
			column("reason", "text", false),
			column("bytes", "integer", false),
			column("taken_at", "integer", false),
			column("published_through", "integer", true),
			column("generation", "integer", true),
			column("legacy_store_id", 128, true),
			column("engine", 16, false, {
				suffix: [" CHECK (\"engine\" IN ('sqlite','pg','mysql'))", " CHECK (`engine` IN ('sqlite','pg','mysql'))"],
			}),
		],
		["id"],
		['PRIMARY KEY ("id")', "PRIMARY KEY (`id`)"],
		[
			{ foreignKeys: [], checks: ["(engine = ANY (ARRAY['sqlite'::text, 'pg'::text, 'mysql'::text]))"] },
			{ foreignKeys: [], checks: ["(`engine` in (_utf8mb4\\'sqlite\\',_utf8mb4\\'pg\\',_utf8mb4\\'mysql\\'))"] },
		],
		[],
	),
	bootTable(
		sql,
		engine,
		9,
		"cutover",
		[
			column("singleton", "integer", false, { suffix: [' CHECK ("singleton"=1)', " CHECK (`singleton`=1)"] }),
			column("candidate", "integer", false),
			column("prior", "integer", true),
			column("backup", 128, true),
			column("lock_id", 128, false),
			column("family", 128, false),
			column("phase", 128, false),
			column("candidate_epoch", 128, true),
		],
		["singleton"],
		['PRIMARY KEY ("singleton")', "PRIMARY KEY (`singleton`)"],
		[
			{ foreignKeys: [], checks: ["(singleton = 1)"] },
			{ foreignKeys: [], checks: ["(`singleton` = 1)"] },
		],
		[],
	),
	bootTable(
		sql,
		engine,
		13,
		"db_restore_requests",
		[
			column("proof_id", 128, false),
			column("proof_hash", 64, false),
			column("session_id", 128, false),
			column("idempotency_key", 200, true),
			column("backup", 128, false),
			column("phase", 16, false, {
				suffix: [
					" CHECK (\"phase\" IN ('authorized','restoring','working','rollback','restored','failed'))",
					" CHECK (`phase` IN ('authorized','restoring','working','rollback','restored','failed'))",
				],
			}),
			column("safety_backup", 128, true),
			column("generation", "integer", true),
			column("restored_to_seq", "integer", false),
			column("event_seq", "integer", true),
			column("failure", "text", true),
			column("lock_id", 128, true),
			column("lock_family", 128, true),
			column("lock_owned", "integer", false, {
				defaults: ["0", "0"],
				suffix: [' DEFAULT 0 CHECK ("lock_owned" IN (0,1))', " DEFAULT 0 CHECK (`lock_owned` IN (0,1))"],
			}),
			column("candidate_epoch", 128, true),
			column("source_generation", "integer", true),
			column("prior_generation", "integer", true),
			column("source_batch", 128, true),
			column("active_guard", "integer", true, {
				suffix: [
					" GENERATED ALWAYS AS (CASE WHEN \"phase\" IN ('authorized','restoring','working','rollback') THEN 1 ELSE NULL END) STORED",
					" GENERATED ALWAYS AS (CASE WHEN `phase` IN ('authorized','restoring','working','rollback') THEN 1 ELSE NULL END) STORED",
				],
				expressions: [
					"\nCASE\n    WHEN (phase = ANY (ARRAY['authorized'::text, 'restoring'::text, 'working'::text, 'rollback'::text])) THEN 1\n    ELSE NULL::integer\nEND",
					"(case when (`phase` in (_utf8mb4\\'authorized\\',_utf8mb4\\'restoring\\',_utf8mb4\\'working\\',_utf8mb4\\'rollback\\')) then 1 else NULL end)",
				],
			}),
		],
		["proof_id"],
		['PRIMARY KEY ("proof_id")', "PRIMARY KEY (`proof_id`)"],
		[
			{
				foreignKeys: [],
				checks: [
					"(lock_owned = ANY (ARRAY[(0)::bigint, (1)::bigint]))",
					"(phase = ANY (ARRAY['authorized'::text, 'restoring'::text, 'working'::text, 'rollback'::text, 'restored'::text, 'failed'::text]))",
				],
			},
			{
				foreignKeys: [],
				checks: [
					"(`phase` in (_utf8mb4\\'authorized\\',_utf8mb4\\'restoring\\',_utf8mb4\\'working\\',_utf8mb4\\'rollback\\',_utf8mb4\\'restored\\',_utf8mb4\\'failed\\'))",
					"(`lock_owned` in (0,1))",
				],
			},
		],
		[],
	),
	bootTable(
		sql,
		engine,
		14,
		"public_paths",
		[column("row_id", "integer", false, { identity: true }), column("path", "text", false), hashColumn("path")],
		["row_id"],
		['PRIMARY KEY ("row_id")', "PRIMARY KEY (`row_id`)"],
		[
			{ foreignKeys: [], checks: [] },
			{ foreignKeys: [], checks: [] },
		],
		[{ name: "public_paths_path_hash_unique", columns: ["path_hash"] }],
	),
];
