import { bootTable, column, hashColumn, eventColumn } from "./boot-table-definition.ts";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

export const eventTables = (sql: SqlClient, engine: "pg" | "mysql") => [
	bootTable(
		sql,
		engine,
		6,
		"seq",
		[
			column("singleton", "integer", false, { suffix: [' CHECK ("singleton"=1)', " CHECK (`singleton`=1)"] }),
			column("next", "integer", false),
			column("published_through", "integer", false),
			column("pending_id", "text", true),
			column("pending_attempt", 128, true),
			column("pending_from", "integer", true),
			column("pending_to", "integer", true),
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
		6,
		"events",
		[
			column("seq", "integer", false),
			column("transaction_id", "text", true),
			column("event", "text", false),
			column("topic", "text", true),
			eventColumn("type"),
			eventColumn("actor"),
			eventColumn("instance"),
			eventColumn("level"),
		],
		["seq"],
		['PRIMARY KEY ("seq")', "PRIMARY KEY (`seq`)"],
		[
			{ foreignKeys: [], checks: [] },
			{ foreignKeys: [], checks: [] },
		],
		[],
	),
	bootTable(
		sql,
		engine,
		6,
		"event_batches",
		[
			column("row_id", "integer", false, { identity: true }),
			column("id", "text", false),
			column("attempt", 128, false),
			column("from_seq", "integer", false),
			column("to_seq", "integer", false),
			column("state", 128, false),
			hashColumn("id"),
		],
		["row_id"],
		['PRIMARY KEY ("row_id")', "PRIMARY KEY (`row_id`)"],
		[
			{ foreignKeys: [], checks: [] },
			{ foreignKeys: [], checks: [] },
		],
		[{ name: "event_batches_id_hash_unique", columns: ["id_hash"] }],
	),
];
