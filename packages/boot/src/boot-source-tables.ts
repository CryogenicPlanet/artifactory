import { bootTable, column, hashColumn } from "./boot-table-definition.ts";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

export const sourceTables = (sql: SqlClient, engine: "pg" | "mysql") => [
	bootTable(
		sql,
		engine,
		3,
		"edit_lock",
		[
			column("singleton", "integer", false, { suffix: [' CHECK ("singleton"=1)', " CHECK (`singleton`=1)"] }),
			column("id", 128, false),
			column("holder_family", 128, false),
			column("agent", 64, false),
			column("since", "integer", false),
			column("expires", "integer", false),
			column("ttl_seconds", "integer", false, {
				suffix: [' CHECK ("ttl_seconds" BETWEEN 1 AND 3600)', " CHECK (`ttl_seconds` BETWEEN 1 AND 3600)"],
			}),
			column("note", "text", false),
			column("cutover_in_flight", "integer", false, {
				defaults: ["0", "0"],
				suffix: [' DEFAULT 0 CHECK ("cutover_in_flight" IN (0,1))', " DEFAULT 0 CHECK (`cutover_in_flight` IN (0,1))"],
			}),
			column("pending_release", 16, true, {
				suffix: [
					" CHECK (\"pending_release\" IN ('broken','revoked'))",
					" CHECK (`pending_release` IN ('broken','revoked'))",
				],
			}),
			column("reset_pin", "integer", false, {
				defaults: ["0", "0"],
				suffix: [' DEFAULT 0 CHECK ("reset_pin" IN (0,1,2))', " DEFAULT 0 CHECK (`reset_pin` IN (0,1,2))"],
			}),
		],
		["singleton"],
		['PRIMARY KEY ("singleton")', "PRIMARY KEY (`singleton`)"],
		[
			{
				foreignKeys: [],
				checks: [
					"(cutover_in_flight = ANY (ARRAY[(0)::bigint, (1)::bigint]))",
					"(pending_release = ANY (ARRAY['broken'::text, 'revoked'::text]))",
					"(reset_pin = ANY (ARRAY[(0)::bigint, (1)::bigint, (2)::bigint]))",
					"(singleton = 1)",
					"((ttl_seconds >= 1) AND (ttl_seconds <= 3600))",
				],
			},
			{
				foreignKeys: [],
				checks: [
					"(`singleton` = 1)",
					"(`ttl_seconds` between 1 and 3600)",
					"(`cutover_in_flight` in (0,1))",
					"(`pending_release` in (_utf8mb4\\'broken\\',_utf8mb4\\'revoked\\'))",
					"(`reset_pin` in (0,1,2))",
				],
			},
		],
		[{ name: "edit_lock_id_unique", columns: ["id"] }],
	),
	bootTable(
		sql,
		engine,
		3,
		"staging",
		[
			column("row_id", "integer", false, { identity: true }),
			column("lock_id", 128, false),
			column("path", "text", false),
			column("content", "blob", true),
			column("sha", 64, true),
			column("at", "integer", false),
			column("mode", "integer", true),
			hashColumn("path"),
		],
		["row_id"],
		[
			'PRIMARY KEY ("row_id"),\nCHECK (("content" IS NULL)=("sha" IS NULL))',
			"PRIMARY KEY (`row_id`),\nCHECK ((`content` IS NULL)=(`sha` IS NULL))",
		],
		[
			{ foreignKeys: [], checks: ["((content IS NULL) = (sha IS NULL))"] },
			{ foreignKeys: [], checks: ["((`content` is null) = (`sha` is null))"] },
		],
		[{ name: "staging_lock_id_path_hash_unique", columns: ["lock_id", "path_hash"] }],
	),
	bootTable(
		sql,
		engine,
		5,
		"source_batches",
		[
			column("id", 128, false),
			column("lock_id", 128, true),
			column("agent", 64, false),
			column("at", "integer", false),
			column("state", 16, false, {
				suffix: [" CHECK (\"state\" IN ('publishing','published'))", " CHECK (`state` IN ('publishing','published'))"],
			}),
			column("publishing_guard", "integer", true, {
				suffix: [
					" GENERATED ALWAYS AS (CASE WHEN \"state\"='publishing' THEN 1 ELSE NULL END) STORED",
					" GENERATED ALWAYS AS (CASE WHEN `state`='publishing' THEN 1 ELSE NULL END) STORED",
				],
				expressions: [
					"\nCASE\n    WHEN (state = 'publishing'::text) THEN 1\n    ELSE NULL::integer\nEND",
					"(case when (`state` = _utf8mb4\\'publishing\\') then 1 else NULL end)",
				],
			}),
		],
		["id"],
		['PRIMARY KEY ("id")', "PRIMARY KEY (`id`)"],
		[
			{ foreignKeys: [], checks: ["(state = ANY (ARRAY['publishing'::text, 'published'::text]))"] },
			{ foreignKeys: [], checks: ["(`state` in (_utf8mb4\\'publishing\\',_utf8mb4\\'published\\'))"] },
		],
		[],
	),
	bootTable(
		sql,
		engine,
		5,
		"source_changes",
		[
			column("row_id", "integer", false, { identity: true }),
			column("batch", 128, false),
			column("path", "text", false),
			column("before", "blob", true),
			column("before_sha", 64, true),
			column("before_mode", "integer", true),
			column("desired", "blob", true),
			column("desired_sha", 64, true),
			column("desired_mode", "integer", true),
			column("before_directory", "integer", false, {
				defaults: ["0", "0"],
				suffix: [' DEFAULT 0 CHECK ("before_directory" IN (0,1))', " DEFAULT 0 CHECK (`before_directory` IN (0,1))"],
			}),
			column("desired_directory", "integer", false, {
				defaults: ["0", "0"],
				suffix: [' DEFAULT 0 CHECK ("desired_directory" IN (0,1))', " DEFAULT 0 CHECK (`desired_directory` IN (0,1))"],
			}),
			hashColumn("path"),
		],
		["row_id"],
		[
			'PRIMARY KEY ("row_id"),\nFOREIGN KEY ("batch") REFERENCES "source_batches"("id"),\nCHECK (("before" IS NULL)=("before_sha" IS NULL)),\nCHECK (("before" IS NULL)=("before_mode" IS NULL)),\nCHECK (("desired" IS NULL)=("desired_sha" IS NULL)),\nCHECK (("desired" IS NULL)=("desired_mode" IS NULL))',
			"PRIMARY KEY (`row_id`),\nFOREIGN KEY (`batch`) REFERENCES `source_batches`(`id`),\nCHECK ((`before` IS NULL)=(`before_sha` IS NULL)),\nCHECK ((`before` IS NULL)=(`before_mode` IS NULL)),\nCHECK ((`desired` IS NULL)=(`desired_sha` IS NULL)),\nCHECK ((`desired` IS NULL)=(`desired_mode` IS NULL))",
		],
		[
			{
				foreignKeys: [{ column: "batch", table: "source_batches", target: "id" }],
				checks: [
					"(before_directory = ANY (ARRAY[(0)::bigint, (1)::bigint]))",
					"((before IS NULL) = (before_sha IS NULL))",
					"((before IS NULL) = (before_mode IS NULL))",
					"((desired IS NULL) = (desired_sha IS NULL))",
					"((desired IS NULL) = (desired_mode IS NULL))",
					"(desired_directory = ANY (ARRAY[(0)::bigint, (1)::bigint]))",
				],
			},
			{
				foreignKeys: [{ column: "batch", table: "source_batches", target: "id" }],
				checks: [
					"(`before_directory` in (0,1))",
					"(`desired_directory` in (0,1))",
					"((`before` is null) = (`before_sha` is null))",
					"((`before` is null) = (`before_mode` is null))",
					"((`desired` is null) = (`desired_sha` is null))",
					"((`desired` is null) = (`desired_mode` is null))",
				],
			},
		],
		[{ name: "source_changes_batch_path_hash_unique", columns: ["batch", "path_hash"] }],
	),
	bootTable(
		sql,
		engine,
		5,
		"versions",
		[
			column("id", "integer", false, { identity: true }),
			column("batch", 128, false),
			column("path", "text", false),
			column("agent", 64, false),
			column("at", "integer", false),
			column("content", "blob", true),
			column("sha", 64, true),
			column("mode", "integer", true),
			column("previous_content", "blob", true),
			column("previous_sha", 64, true),
			column("previous_mode", "integer", true),
			column("versioned", "integer", false, {
				suffix: [' CHECK ("versioned" IN (0,1))', " CHECK (`versioned` IN (0,1))"],
			}),
			column("reason", 16, true, { suffix: [" CHECK (\"reason\"='size_limit')", " CHECK (`reason`='size_limit')"] }),
			column("previous_directory", "integer", false, {
				defaults: ["0", "0"],
				suffix: [
					' DEFAULT 0 CHECK ("previous_directory" IN (0,1))',
					" DEFAULT 0 CHECK (`previous_directory` IN (0,1))",
				],
			}),
			column("directory", "integer", false, {
				defaults: ["0", "0"],
				suffix: [' DEFAULT 0 CHECK ("directory" IN (0,1))', " DEFAULT 0 CHECK (`directory` IN (0,1))"],
			}),
			hashColumn("path"),
		],
		["id"],
		[
			'PRIMARY KEY ("id"),\nFOREIGN KEY ("batch") REFERENCES "source_batches"("id")',
			"PRIMARY KEY (`id`),\nFOREIGN KEY (`batch`) REFERENCES `source_batches`(`id`)",
		],
		[
			{
				foreignKeys: [{ column: "batch", table: "source_batches", target: "id" }],
				checks: [
					"(directory = ANY (ARRAY[(0)::bigint, (1)::bigint]))",
					"(previous_directory = ANY (ARRAY[(0)::bigint, (1)::bigint]))",
					"(reason = 'size_limit'::text)",
					"(versioned = ANY (ARRAY[(0)::bigint, (1)::bigint]))",
				],
			},
			{
				foreignKeys: [{ column: "batch", table: "source_batches", target: "id" }],
				checks: [
					"(`versioned` in (0,1))",
					"(`reason` = _utf8mb4\\'size_limit\\')",
					"(`previous_directory` in (0,1))",
					"(`directory` in (0,1))",
				],
			},
		],
		[{ name: "versions_batch_path_hash_unique", columns: ["batch", "path_hash"] }],
	),
];
