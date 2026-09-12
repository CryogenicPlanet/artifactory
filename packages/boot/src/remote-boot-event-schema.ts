import { bootTableShape } from "./remote-boot-schema-shape.ts";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

/** Explicit fresh remote schema; existing SQLite histories use boot-schema.ts. */
export const remoteBootEvent = (sql: SqlClient, engine: "pg" | "mysql") =>
	[
		{
			step: 6,
			name: "seq",
			unique: [],
			run: sql.unsafe(
				engine === "pg"
					? 'CREATE TABLE "seq" (\n"singleton" bigint NOT NULL CHECK ("singleton"=1),\n"next" bigint NOT NULL,\n"published_through" bigint NOT NULL,\n"pending_id" text,\n"pending_attempt" text,\n"pending_from" bigint,\n"pending_to" bigint,\nPRIMARY KEY ("singleton")\n)'
					: "CREATE TABLE `seq` (\n`singleton` bigint NOT NULL CHECK (`singleton`=1),\n`next` bigint NOT NULL,\n`published_through` bigint NOT NULL,\n`pending_id` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin,\n`pending_attempt` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin,\n`pending_from` bigint,\n`pending_to` bigint,\nPRIMARY KEY (`singleton`)\n) ENGINE=InnoDB",
			),
			postcondition: bootTableShape(
				sql,
				engine,
				"seq",
				engine === "pg"
					? [
							{ name: "singleton", type: "bigint", nullable: false },
							{ name: "next", type: "bigint", nullable: false },
							{ name: "published_through", type: "bigint", nullable: false },
							{ name: "pending_id", type: "text", nullable: true },
							{ name: "pending_attempt", type: "text", nullable: true },
							{ name: "pending_from", type: "bigint", nullable: true },
							{ name: "pending_to", type: "bigint", nullable: true },
						]
					: [
							{ name: "singleton", type: "bigint", nullable: false },
							{ name: "next", type: "bigint", nullable: false },
							{ name: "published_through", type: "bigint", nullable: false },
							{ name: "pending_id", type: "longtext", nullable: true },
							{ name: "pending_attempt", type: "varchar", nullable: true, length: 128 },
							{ name: "pending_from", type: "bigint", nullable: true },
							{ name: "pending_to", type: "bigint", nullable: true },
						],
				["singleton"],
				{ foreignKeys: [], checks: engine === "pg" ? ["(singleton = 1)"] : ["(`singleton` = 1)"] },
			),
		},
		{
			step: 6,
			name: "events",
			unique: [],
			run: sql.unsafe(
				engine === "pg"
					? 'CREATE TABLE "events" (\n"seq" bigint NOT NULL,\n"transaction_id" text,\n"event" text NOT NULL,\n"topic" text,\n"type" text GENERATED ALWAYS AS (("event"::jsonb ->> \'type\')) STORED,\n"actor" text GENERATED ALWAYS AS (("event"::jsonb ->> \'actor\')) STORED,\n"instance" text GENERATED ALWAYS AS (("event"::jsonb ->> \'instance\')) STORED,\n"level" text GENERATED ALWAYS AS (("event"::jsonb ->> \'level\')) STORED,\nPRIMARY KEY ("seq")\n)'
					: "CREATE TABLE `events` (\n`seq` bigint NOT NULL,\n`transaction_id` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin,\n`event` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,\n`topic` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin,\n`type` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin GENERATED ALWAYS AS (CASE WHEN JSON_TYPE(JSON_EXTRACT(`event`,'$.type'))='NULL' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(`event`,'$.type')) END) STORED,\n`actor` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin GENERATED ALWAYS AS (CASE WHEN JSON_TYPE(JSON_EXTRACT(`event`,'$.actor'))='NULL' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(`event`,'$.actor')) END) STORED,\n`instance` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin GENERATED ALWAYS AS (CASE WHEN JSON_TYPE(JSON_EXTRACT(`event`,'$.instance'))='NULL' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(`event`,'$.instance')) END) STORED,\n`level` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin GENERATED ALWAYS AS (CASE WHEN JSON_TYPE(JSON_EXTRACT(`event`,'$.level'))='NULL' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(`event`,'$.level')) END) STORED,\nPRIMARY KEY (`seq`)\n) ENGINE=InnoDB",
			),
			postcondition: bootTableShape(
				sql,
				engine,
				"events",
				engine === "pg"
					? [
							{ name: "seq", type: "bigint", nullable: false },
							{ name: "transaction_id", type: "text", nullable: true },
							{ name: "event", type: "text", nullable: false },
							{ name: "topic", type: "text", nullable: true },
							{ name: "type", type: "text", nullable: true, expression: "((event)::jsonb ->> 'type'::text)" },
							{ name: "actor", type: "text", nullable: true, expression: "((event)::jsonb ->> 'actor'::text)" },
							{ name: "instance", type: "text", nullable: true, expression: "((event)::jsonb ->> 'instance'::text)" },
							{ name: "level", type: "text", nullable: true, expression: "((event)::jsonb ->> 'level'::text)" },
						]
					: [
							{ name: "seq", type: "bigint", nullable: false },
							{ name: "transaction_id", type: "longtext", nullable: true },
							{ name: "event", type: "longtext", nullable: false },
							{ name: "topic", type: "longtext", nullable: true },
							{
								name: "type",
								type: "longtext",
								nullable: true,
								expression:
									"(case when (json_type(json_extract(`event`,_utf8mb4\\'$.type\\')) = _utf8mb4\\'NULL\\') then NULL else json_unquote(json_extract(`event`,_utf8mb4\\'$.type\\')) end)",
							},
							{
								name: "actor",
								type: "longtext",
								nullable: true,
								expression:
									"(case when (json_type(json_extract(`event`,_utf8mb4\\'$.actor\\')) = _utf8mb4\\'NULL\\') then NULL else json_unquote(json_extract(`event`,_utf8mb4\\'$.actor\\')) end)",
							},
							{
								name: "instance",
								type: "longtext",
								nullable: true,
								expression:
									"(case when (json_type(json_extract(`event`,_utf8mb4\\'$.instance\\')) = _utf8mb4\\'NULL\\') then NULL else json_unquote(json_extract(`event`,_utf8mb4\\'$.instance\\')) end)",
							},
							{
								name: "level",
								type: "longtext",
								nullable: true,
								expression:
									"(case when (json_type(json_extract(`event`,_utf8mb4\\'$.level\\')) = _utf8mb4\\'NULL\\') then NULL else json_unquote(json_extract(`event`,_utf8mb4\\'$.level\\')) end)",
							},
						],
				["seq"],
				{ foreignKeys: [], checks: engine === "pg" ? [] : [] },
			),
		},
		{
			step: 6,
			name: "event_batches",
			unique: [{ name: "event_batches_id_hash_unique", columns: ["id_hash"] }],
			run: sql.unsafe(
				engine === "pg"
					? 'CREATE TABLE "event_batches" (\n"row_id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n"id" text NOT NULL,\n"attempt" text NOT NULL,\n"from_seq" bigint NOT NULL,\n"to_seq" bigint NOT NULL,\n"state" text NOT NULL,\n"id_hash" text GENERATED ALWAYS AS (encode(sha256(decode(replace("id",chr(92),chr(92)||chr(92)),\'escape\')),\'hex\')) STORED,\nPRIMARY KEY ("row_id")\n)'
					: "CREATE TABLE `event_batches` (\n`row_id` bigint AUTO_INCREMENT NOT NULL,\n`id` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,\n`attempt` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,\n`from_seq` bigint NOT NULL,\n`to_seq` bigint NOT NULL,\n`state` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,\n`id_hash` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin GENERATED ALWAYS AS (SHA2(`id`,256)) STORED,\nPRIMARY KEY (`row_id`)\n) ENGINE=InnoDB",
			),
			postcondition: bootTableShape(
				sql,
				engine,
				"event_batches",
				engine === "pg"
					? [
							{ name: "row_id", type: "bigint", nullable: false, identity: true },
							{ name: "id", type: "text", nullable: false },
							{ name: "attempt", type: "text", nullable: false },
							{ name: "from_seq", type: "bigint", nullable: false },
							{ name: "to_seq", type: "bigint", nullable: false },
							{ name: "state", type: "text", nullable: false },
							{
								name: "id_hash",
								type: "text",
								nullable: true,
								expression:
									"encode(sha256(decode(replace(id, chr(92), (chr(92) || chr(92))), 'escape'::text)), 'hex'::text)",
							},
						]
					: [
							{ name: "row_id", type: "bigint", nullable: false, identity: true },
							{ name: "id", type: "longtext", nullable: false },
							{ name: "attempt", type: "varchar", nullable: false, length: 128 },
							{ name: "from_seq", type: "bigint", nullable: false },
							{ name: "to_seq", type: "bigint", nullable: false },
							{ name: "state", type: "varchar", nullable: false, length: 128 },
							{ name: "id_hash", type: "varchar", nullable: true, length: 64, expression: "sha2(`id`,256)" },
						],
				["row_id"],
				{ foreignKeys: [], checks: engine === "pg" ? [] : [] },
			),
		},
	] as const;
