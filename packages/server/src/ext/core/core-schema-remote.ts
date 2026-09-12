import { on } from "@comms/storage/dialect";
import { indexShape, remoteMigrate, tableShape, type RemoteStep } from "@comms/storage/remote-migrations";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Statement } from "effect/unstable/sql/Statement";
import { coreJsonOperations, type CoreJsonSchemaError } from "./core-json-schema.ts";
import { postgresSearchOperation, postgresSearchShape, postgresSearchMode } from "./core-search-schema.ts";
import { KernelError } from "../../kernel/boot-channel.ts";
import { writerGate } from "../../kernel/database.ts";

/** Remote stores have no supported pre-ledger schema. Build final table shapes directly;
 * legacy receipt conversion and retired product tables belong only to SQLite adoption. */
export const remoteCoreSteps = (
	sql: SqlClient,
): ReadonlyArray<RemoteStep<Effect.Error<ReturnType<typeof tableShape>> | CoreJsonSchemaError | KernelError>> => {
	const mysql = on(sql, { sqlite: () => false, pg: () => false, mysql: () => true });
	const text = (name: string, nullable = false) => ({
		name,
		type: mysql ? "longtext" : "text",
		nullable,
		default: null,
		...(mysql
			? { collation: name === "body" || name === "previous_body" ? "utf8mb4_0900_ai_ci" : "utf8mb4_0900_bin" }
			: {}),
	});
	const key = (name: string, nullable = false) => ({
		name,
		type: mysql ? "varchar" : "text",
		nullable,
		default: null,
		...(mysql ? { length: 256, collation: "utf8mb4_0900_bin" } : {}),
	});
	const integer = (name: string, nullable = false) => ({ name, type: "bigint", nullable, default: null });
	const ddl = (name: string, run: Statement<unknown>, postcondition: ReturnType<typeof tableShape>) => ({
		name,
		run: run.pipe(Effect.asVoid),
		postcondition,
	});
	const statements = {
		topics: mysql
			? sql`CREATE TABLE topics(path VARCHAR(256) PRIMARY KEY,parent VARCHAR(256),name LONGTEXT NOT NULL,meta LONGTEXT NOT NULL,last_seq BIGINT NOT NULL,created_at BIGINT NOT NULL,archived_at BIGINT,updated_seq BIGINT NOT NULL DEFAULT 0,previous LONGTEXT,deleted_at BIGINT) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`
			: sql`CREATE TABLE topics(path TEXT PRIMARY KEY,parent TEXT,name TEXT NOT NULL,meta TEXT NOT NULL,last_seq BIGINT NOT NULL,created_at BIGINT NOT NULL,archived_at BIGINT,updated_seq BIGINT NOT NULL DEFAULT 0,previous TEXT,deleted_at BIGINT)`,
		messages: mysql
			? sql`CREATE TABLE messages(id VARCHAR(256) PRIMARY KEY,seq BIGINT NOT NULL,topic VARCHAR(256) NOT NULL,agent LONGTEXT NOT NULL,instance LONGTEXT NOT NULL,body LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,tags LONGTEXT NOT NULL,meta LONGTEXT NOT NULL,created_at BIGINT NOT NULL,edited_at BIGINT,deleted_at BIGINT,updated_seq BIGINT NOT NULL DEFAULT 0,previous LONGTEXT,mentions LONGTEXT NOT NULL DEFAULT ('[]'),previous_mentions LONGTEXT NOT NULL DEFAULT ('[]'),previous_body LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci GENERATED ALWAYS AS (CASE WHEN JSON_TYPE(JSON_EXTRACT(previous,'$.body'))='NULL' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(previous,'$.body')) END) STORED) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`
			: sql`CREATE TABLE messages(id TEXT PRIMARY KEY,seq BIGINT NOT NULL,topic TEXT NOT NULL,agent TEXT NOT NULL,instance TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,meta TEXT NOT NULL,created_at BIGINT NOT NULL,edited_at BIGINT,deleted_at BIGINT,updated_seq BIGINT NOT NULL DEFAULT 0,previous TEXT,mentions TEXT NOT NULL DEFAULT '[]',previous_mentions TEXT NOT NULL DEFAULT '[]',body_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',coalesce(body,''))) STORED,previous_body_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',coalesce(previous::jsonb->>'body',''))) STORED)`,
		reads: mysql
			? sql`CREATE TABLE ${sql("reads")}(instance VARCHAR(256) NOT NULL,topic VARCHAR(256) NOT NULL,seq BIGINT NOT NULL,PRIMARY KEY(instance,topic)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`
			: sql`CREATE TABLE ${sql("reads")}(instance TEXT NOT NULL,topic TEXT NOT NULL,seq BIGINT NOT NULL,PRIMARY KEY(instance,topic))`,
		kv: mysql
			? sql`CREATE TABLE kv(ns VARCHAR(256) NOT NULL,\`key\` VARCHAR(256) NOT NULL,value LONGTEXT,updated_seq BIGINT NOT NULL,previous LONGTEXT,PRIMARY KEY(ns,\`key\`)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`
			: sql`CREATE TABLE kv(ns TEXT NOT NULL,key TEXT NOT NULL,value TEXT,updated_seq BIGINT NOT NULL,previous TEXT,PRIMARY KEY(ns,key))`,
		// Literal keys remain unbounded. A hash collision refuses the insert rather than replacing a receipt.
		// PostgreSQL convert_to is STABLE; doubling escape bytes keeps UTF-8 hashing immutable.
		idempotency: mysql
			? sql`CREATE TABLE idempotency(row_id BIGINT AUTO_INCREMENT PRIMARY KEY,instance VARCHAR(256) NOT NULL,\`key\` LONGTEXT NOT NULL,key_hash VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin GENERATED ALWAYS AS (SHA2(\`key\`,256)) STORED,kind LONGTEXT NOT NULL,input_hash LONGTEXT NOT NULL,outcome LONGTEXT NOT NULL,expires_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`
			: sql`CREATE TABLE idempotency(row_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,instance TEXT NOT NULL,key TEXT NOT NULL,key_hash TEXT GENERATED ALWAYS AS (encode(sha256(decode(replace(key,chr(92),chr(92)||chr(92)),'escape')),'hex')) STORED,kind TEXT NOT NULL,input_hash TEXT NOT NULL,outcome TEXT NOT NULL,expires_at BIGINT NOT NULL)`,
		continuations: mysql
			? sql`CREATE TABLE topic_page_continuations(seq BIGINT PRIMARY KEY,from_path LONGTEXT NOT NULL,to_path LONGTEXT NOT NULL,marker LONGTEXT NOT NULL,completed SMALLINT NOT NULL CHECK(completed IN (0,1))) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`
			: sql`CREATE TABLE topic_page_continuations(seq BIGINT PRIMARY KEY,from_path TEXT NOT NULL,to_path TEXT NOT NULL,marker TEXT NOT NULL,completed SMALLINT NOT NULL CHECK(completed IN (0,1)))`,
	};
	return [
		{
			id: 1,
			name: "messages",
			operations: [
				ddl(
					"topics",
					statements.topics,
					tableShape(
						sql,
						"topics",
						[
							key("path"),
							key("parent", true),
							text("name"),
							text("meta"),
							integer("last_seq"),
							integer("created_at"),
							integer("archived_at", true),
							{ ...integer("updated_seq"), default: "0" },
							text("previous", true),
							integer("deleted_at", true),
						],
						["path"],
						{ checks: [], foreignKeys: [] },
					),
				),
				ddl(
					"topics_parent",
					sql`CREATE INDEX topics_parent ON topics(parent)`,
					indexShape(sql, "topics", "topics_parent", ["parent"], false),
				),
				ddl(
					"messages",
					statements.messages,
					tableShape(
						sql,
						"messages",
						[
							key("id"),
							integer("seq"),
							key("topic"),
							text("agent"),
							text("instance"),
							text("body"),
							text("tags"),
							text("meta"),
							integer("created_at"),
							integer("edited_at", true),
							integer("deleted_at", true),
							{ ...integer("updated_seq"), default: "0" },
							text("previous", true),
							{ ...text("mentions"), default: mysql ? "_utf8mb4\\'[]\\'" : "'[]'::text" },
							{ ...text("previous_mentions"), default: mysql ? "_utf8mb4\\'[]\\'" : "'[]'::text" },
							...(mysql
								? [
										{
											...text("previous_body", true),
											expression:
												"(case when (json_type(json_extract(`previous`,_utf8mb4\\'$.body\\')) = _utf8mb4\\'NULL\\') then NULL else json_unquote(json_extract(`previous`,_utf8mb4\\'$.body\\')) end)",
										},
									]
								: [
										{
											name: "body_tsv",
											type: "tsvector",
											nullable: true,
											default: null,
											expression: "to_tsvector('simple'::regconfig, COALESCE(body, ''::text))",
										},
										{
											name: "previous_body_tsv",
											type: "tsvector",
											nullable: true,
											default: null,
											expression:
												"to_tsvector('simple'::regconfig, COALESCE(((previous)::jsonb ->> 'body'::text), ''::text))",
										},
									]),
						],
						["id"],
						{ checks: [], foreignKeys: [] },
					),
				),
				ddl(
					"messages_seq",
					sql`CREATE UNIQUE INDEX messages_seq ON messages(seq)`,
					indexShape(sql, "messages", "messages_seq", ["seq"], true),
				),
				ddl(
					"messages_topic_seq",
					sql`CREATE INDEX messages_topic_seq ON messages(topic,seq)`,
					indexShape(sql, "messages", "messages_topic_seq", ["topic", "seq"], false),
				),
			],
		},
		{
			id: 2,
			name: "reads",
			operations: [
				ddl(
					"reads",
					statements.reads,
					tableShape(sql, "reads", [key("instance"), key("topic"), integer("seq")], ["instance", "topic"], {
						checks: [],
						foreignKeys: [],
					}),
				),
			],
		},
		{ id: 3, name: "message_edits", operations: [] },
		{
			id: 4,
			name: "topic_edits_search",
			operations: mysql
				? [
						ddl(
							"messages_body_ft",
							sql`CREATE FULLTEXT INDEX messages_body_ft ON messages(body)`,
							indexShape(sql, "messages", "messages_body_ft", ["body"], false, "FULLTEXT"),
						),
						ddl(
							"messages_previous_body_ft",
							sql`CREATE FULLTEXT INDEX messages_previous_body_ft ON messages(previous_body)`,
							indexShape(sql, "messages", "messages_previous_body_ft", ["previous_body"], false, "FULLTEXT"),
						),
					]
				: [
						ddl(
							"messages_body_tsv",
							sql`CREATE INDEX messages_body_tsv ON messages USING gin(body_tsv)`,
							indexShape(sql, "messages", "messages_body_tsv", ["body_tsv"], false, "gin"),
						),
						ddl(
							"messages_previous_body_tsv",
							sql`CREATE INDEX messages_previous_body_tsv ON messages USING gin(previous_body_tsv)`,
							indexShape(sql, "messages", "messages_previous_body_tsv", ["previous_body_tsv"], false, "gin"),
						),
					],
		},
		{
			id: 5,
			name: "agents_kv",
			operations: [
				ddl(
					"kv",
					statements.kv,
					tableShape(
						sql,
						"kv",
						[key("ns"), key("key"), text("value", true), integer("updated_seq"), text("previous", true)],
						["ns", "key"],
						{ checks: [], foreignKeys: [] },
					),
				),
			],
		},
		{ id: 6, name: "topic_deletion", operations: [] },
		{
			id: 7,
			name: "idempotency_mentions",
			operations: [
				ddl(
					"idempotency",
					statements.idempotency,
					tableShape(
						sql,
						"idempotency",
						[
							{ ...integer("row_id"), identity: true, identityGeneration: mysql ? "AUTO_INCREMENT" : "BY DEFAULT" },
							key("instance"),
							text("key"),
							mysql
								? {
										name: "key_hash",
										type: "varchar",
										nullable: true,
										length: 64,
										collation: "utf8mb4_0900_bin",
										default: null,
										expression: "sha2(`key`,256)",
									}
								: {
										name: "key_hash",
										type: "text",
										nullable: true,
										default: null,
										expression:
											"encode(sha256(decode(replace(key, chr(92), (chr(92) || chr(92))), 'escape'::text)), 'hex'::text)",
									},
							text("kind"),
							text("input_hash"),
							text("outcome"),
							integer("expires_at"),
						],
						["row_id"],
						{ checks: [], foreignKeys: [] },
					),
				),
				ddl(
					"idempotency_key",
					sql`CREATE UNIQUE INDEX idempotency_key ON idempotency(instance,key_hash)`,
					indexShape(sql, "idempotency", "idempotency_key", ["instance", "key_hash"], true),
				),
				ddl(
					"idempotency_expiry",
					sql`CREATE INDEX idempotency_expiry ON idempotency(expires_at)`,
					indexShape(sql, "idempotency", "idempotency_expiry", ["expires_at"], false),
				),
			],
		},
		{
			id: 8,
			name: "topic_page_continuations",
			operations: [
				ddl(
					"topic_page_continuations",
					statements.continuations,
					tableShape(
						sql,
						"topic_page_continuations",
						[
							integer("seq"),
							text("from_path"),
							text("to_path"),
							text("marker"),
							{ name: "completed", type: "smallint", nullable: false },
						],
						["seq"],
						{ checks: [mysql ? "(`completed` in (0,1))" : "(completed = ANY (ARRAY[0, 1]))"], foreignKeys: [] },
					),
				),
				ddl(
					"topic_page_continuations_pending",
					sql`CREATE INDEX topic_page_continuations_pending ON topic_page_continuations(completed)`,
					indexShape(sql, "topic_page_continuations", "topic_page_continuations_pending", ["completed"], false),
				),
			],
		},
		{ id: 9, name: "mention_word_boundaries", operations: [] },
		{ id: 10, name: "mention_punctuation", operations: [] },
		{ id: 11, name: "domain_json", operations: coreJsonOperations(sql) },
		{ id: 12, name: "search_diacritics", operations: mysql ? [] : [postgresSearchOperation(sql)] },
	];
};

export const initializeRemoteCore = (sql: SqlClient, epoch: string) =>
	remoteMigrate(
		sql,
		"core_migrations",
		remoteCoreSteps(sql),
		sql.withTransaction(
			Effect.gen(function* () {
				yield* writerGate(sql, epoch);
				if (on(sql, { sqlite: () => false, pg: () => true, mysql: () => false }))
					yield* sql`SELECT current_setting('server_encoding') AS encoding`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ encoding: Schema.Literal("UTF8") })])),
						),
					);
			}),
		),
	).pipe(
		Effect.andThen(
			Effect.gen(function* () {
				if (on(sql, { sqlite: () => false, pg: () => true, mysql: () => false })) {
					if (!(yield* postgresSearchShape(sql))) return yield* new KernelError({ code: "app_schema_unsupported" });
					if ((yield* postgresSearchMode(sql)) === "plain")
						yield* Effect.logWarning("PostgreSQL search diacritic folding unavailable; using simple search");
				}
			}),
		),
	);
