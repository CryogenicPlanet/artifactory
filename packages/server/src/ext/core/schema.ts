import { on } from "@comms/storage/dialect";
import { initializeRemoteCore } from "./core-schema-remote.ts";
import { migrate } from "@comms/storage/migrations";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, KernelError } from "../../kernel/boot-channel.ts";
import { writerGate } from "../../kernel/database.ts";
import { registerProtectedSqlTable } from "../../kernel/protected-sql-tables.ts";
import { initializeMentions, reindexMentions } from "./message-mentions.ts";
import { migrateIdempotency } from "./legacy-idempotency.ts";
export const initialize = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const boot = yield* BootChannel;
	if (on(sql, { sqlite: () => false, pg: () => true, mysql: () => true })) {
		yield* initializeRemoteCore(sql, boot.epoch);
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* writerGate(sql, boot.epoch);
				yield* registerProtectedSqlTable(sql, "topic_page_continuations");
				// Completed ledgers do not recreate missing objects. Probe the live contract,
				// while permitting extensions to add their own columns and indexes.
				yield* sql`SELECT path,parent,name,meta,last_seq,created_at,archived_at,updated_seq,previous,deleted_at FROM topics LIMIT 1`;
				yield* sql`SELECT id,seq,topic,agent,instance,body,tags,meta,created_at,edited_at,deleted_at,updated_seq,previous,mentions,previous_mentions FROM messages LIMIT 1`;
				yield* sql`SELECT instance,${sql("key")},kind,input_hash,outcome,expires_at FROM idempotency LIMIT 1`;
				yield* sql`SELECT instance,topic,seq FROM reads LIMIT 1`;
				yield* sql`SELECT ns,${sql("key")},value,updated_seq,previous FROM kv LIMIT 1`;
				yield* sql`SELECT seq,from_path,to_path,marker,completed FROM topic_page_continuations LIMIT 1`;
				yield* on(sql, {
					sqlite: () => Effect.void,
					pg: () => sql`SELECT body_tsv,previous_body_tsv FROM messages LIMIT 1`.pipe(Effect.asVoid),
					mysql: () => sql`SELECT previous_body FROM messages LIMIT 1`.pipe(Effect.asVoid),
				});
			}),
		);
		return;
	}

	yield* sql`PRAGMA busy_timeout = 2000`;
	const readVersion = sql`PRAGMA user_version`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ user_version: Schema.Int })))),
	);
	const version = (yield* readVersion)[0]?.user_version;
	if (version === undefined || version > 10) return yield* new KernelError({ code: "app_schema_unsupported" });
	yield* sql`PRAGMA journal_mode = WAL`;
	yield* sql`PRAGMA synchronous = FULL`;
	yield* sql.withTransaction(
		Effect.gen(function* () {
			yield* writerGate(sql, boot.epoch);
			const version = (yield* readVersion)[0]?.user_version;
			if (version === undefined || version > 10) return yield* new KernelError({ code: "app_schema_unsupported" });
			if (version >= 1) {
				yield* sql`SELECT path,parent,name,meta,last_seq,created_at FROM topics LIMIT 1`;
				yield* sql`SELECT id,seq,topic,agent,instance,body,tags,meta,created_at FROM messages LIMIT 1`;
				yield* sql`SELECT seq,transaction_id,event,shipped_at FROM outbox LIMIT 1`;
				yield* sql`SELECT id,from_seq,to_seq,count FROM mutation_batches LIMIT 1`;
				if (version < 7) yield* sql`SELECT instance,key,input,message_id,transaction_id FROM idempotency LIMIT 1`;
			}
			yield* migrate(sql, "core_migrations", version, [
				{
					id: 1,
					name: "messages",
					run: Effect.gen(function* () {
						yield* sql`CREATE TABLE topics(path TEXT PRIMARY KEY,parent TEXT,name TEXT NOT NULL,meta TEXT NOT NULL,last_seq INTEGER NOT NULL,created_at INTEGER NOT NULL)`;
						yield* sql`CREATE INDEX topics_parent ON topics(parent)`;
						yield* sql`CREATE TABLE messages(id TEXT PRIMARY KEY,seq INTEGER NOT NULL UNIQUE,topic TEXT NOT NULL,agent TEXT NOT NULL,instance TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,meta TEXT NOT NULL,created_at INTEGER NOT NULL)`;
						yield* sql`CREATE INDEX messages_topic_seq ON messages(topic,seq)`;
						yield* sql`CREATE TABLE idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,message_id TEXT NOT NULL,transaction_id TEXT NOT NULL,PRIMARY KEY(instance,key))`;
					}),
				},
				{
					id: 2,
					name: "reads",
					run: Effect.gen(function* () {
						yield* sql`ALTER TABLE topics ADD COLUMN archived_at INTEGER`;
						yield* sql`CREATE TABLE reads(instance TEXT NOT NULL,topic TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(instance,topic))`;
						yield* sql`CREATE TABLE read_idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,topic TEXT NOT NULL,requested_seq INTEGER NOT NULL,effective_seq INTEGER NOT NULL,PRIMARY KEY(instance,key))`;
					}),
				},
				{
					id: 3,
					name: "message_edits",
					run: Effect.gen(function* () {
						yield* sql`ALTER TABLE messages ADD COLUMN edited_at INTEGER`;
						yield* sql`ALTER TABLE messages ADD COLUMN deleted_at INTEGER`;
						yield* sql`ALTER TABLE messages ADD COLUMN updated_seq INTEGER NOT NULL DEFAULT 0`;
						yield* sql`ALTER TABLE messages ADD COLUMN previous TEXT`;
						yield* sql`ALTER TABLE idempotency ADD COLUMN outcome TEXT`;
						yield* sql`UPDATE idempotency SET outcome=(SELECT json_object('id',id,'seq',seq,'topic',topic,'agent',agent,'instance',instance,'body',body,'tags',json(tags),'meta',json(meta),'created_at',created_at,'edited_at',NULL,'deleted_at',NULL) FROM messages WHERE id=message_id)`;
					}),
				},
				{
					id: 4,
					name: "topic_edits_search",
					run: Effect.gen(function* () {
						yield* sql`ALTER TABLE topics ADD COLUMN updated_seq INTEGER NOT NULL DEFAULT 0`;
						yield* sql`ALTER TABLE topics ADD COLUMN previous TEXT`;
						yield* sql`CREATE TABLE topic_idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(instance,key))`;
						if (version > 0)
							yield* sql`CREATE TABLE reactions(message_id TEXT NOT NULL,instance TEXT NOT NULL,emoji TEXT NOT NULL,active INTEGER NOT NULL,previous_active INTEGER NOT NULL,updated_seq INTEGER NOT NULL,PRIMARY KEY(message_id,instance,emoji))`;
						yield* sql`CREATE TABLE reaction_idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,message TEXT NOT NULL,emoji TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(instance,key))`;
						yield* sql`CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, body, previous_body, tokenize='unicode61 remove_diacritics 2')`;
						yield* sql`INSERT INTO messages_fts(rowid,message_id,body,previous_body) SELECT rowid,id,body,json_extract(previous,'$.body') FROM messages`;
						yield* sql`CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,message_id,body,previous_body) VALUES(new.rowid,new.id,new.body,json_extract(new.previous,'$.body')); END`;
						yield* sql`CREATE TRIGGER messages_fts_update AFTER UPDATE OF body,previous ON messages BEGIN DELETE FROM messages_fts WHERE rowid=old.rowid; INSERT INTO messages_fts(rowid,message_id,body,previous_body) VALUES(new.rowid,new.id,new.body,json_extract(new.previous,'$.body')); END`;
						yield* sql`CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE rowid=old.rowid; END`;
					}),
				},
				{
					id: 5,
					name: "agents_kv",
					run: Effect.gen(function* () {
						if (version > 0)
							yield* sql`CREATE TABLE agents(name TEXT PRIMARY KEY,emoji TEXT,color TEXT,status TEXT NOT NULL)`;
						yield* sql`CREATE TABLE kv(ns TEXT NOT NULL,key TEXT NOT NULL,value TEXT,updated_seq INTEGER NOT NULL,previous TEXT,PRIMARY KEY(ns,key))`;
					}),
				},
				{
					id: 6,
					name: "topic_deletion",
					run: Effect.gen(function* () {
						yield* sql`ALTER TABLE topics ADD COLUMN deleted_at INTEGER`;
					}),
				},
				{
					id: 7,
					name: "idempotency_mentions",
					run: Effect.gen(function* () {
						yield* migrateIdempotency(sql);
						yield* initializeMentions(sql);
					}),
				},
				{
					id: 8,
					name: "topic_page_continuations",
					run: Effect.gen(function* () {
						yield* sql`CREATE TABLE topic_page_continuations(seq INTEGER PRIMARY KEY,from_path TEXT NOT NULL,to_path TEXT NOT NULL,marker TEXT NOT NULL,completed INTEGER NOT NULL CHECK(completed IN (0,1)))`;
						yield* sql`CREATE INDEX topic_page_continuations_pending ON topic_page_continuations(completed) WHERE completed=0`;
					}),
				},
				{
					id: 9,
					name: "mention_word_boundaries",
					run: Effect.gen(function* () {
						if (version >= 7) yield* reindexMentions(sql);
					}),
				},
				{
					id: 10,
					name: "mention_punctuation",
					run: Effect.gen(function* () {
						// Earlier rungs already rebuilt both images using the current mention grammar.
						if (version === 9) yield* reindexMentions(sql);
					}),
				},
			]);
			if (version !== 10) yield* sql`PRAGMA user_version = 10`;
			yield* registerProtectedSqlTable(sql, "topic_page_continuations");
			yield* sql`SELECT deleted_at FROM topics LIMIT 1`;
			yield* sql`SELECT ns,key,value,updated_seq,previous FROM kv LIMIT 1`;
			yield* sql`SELECT updated_seq,previous FROM topics LIMIT 1`;
			yield* sql`SELECT message_id,body,previous_body FROM messages_fts LIMIT 1`;
			yield* sql`SELECT edited_at,deleted_at,updated_seq,previous FROM messages LIMIT 1`;
			yield* sql`SELECT instance,key,kind,input_hash,outcome FROM idempotency LIMIT 1`;
			yield* sql`SELECT archived_at FROM topics LIMIT 1`;
			yield* sql`SELECT instance,topic,seq FROM reads LIMIT 1`;
		}),
	);
});
