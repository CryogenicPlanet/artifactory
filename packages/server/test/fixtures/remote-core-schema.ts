import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { initializeRemoteCore } from "../../src/ext/core/core-schema-remote.ts";
const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const filename = process.env.COMMS_REMOTE_CORE_TEST_CONFIG;
if (!filename) throw new Error("Missing disposable config");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
if (!settings.database.startsWith("comms_schema_")) throw new Error("Disposable schema database required");
const options = {
	connection: { ...settings, password: Redacted.make(settings.password), tls: false },
	attempt: "c1".repeat(32),
};
const layer = remoteClientLayer({ ...options, register: () => Effect.void }).pipe(
	Layer.provide(remoteInspectorLayer(options)),
);
// This fixture requires a fresh disposable database and never drops existing tables.
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient;
		yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch VARCHAR(64) NOT NULL)`;
		yield* sql`INSERT INTO kernel_writer VALUES (1,'core-probe')`;
		yield* sql`CREATE TABLE outbox(seq BIGINT PRIMARY KEY,transaction_id VARCHAR(256) NOT NULL,event TEXT NOT NULL,shipped_at BIGINT)`;

		yield* initializeRemoteCore(sql, "core-probe");
		const key = JSON.stringify(["key", '"\\'.repeat(200) + "héllo\\x雪😀"]);
		yield* sql`INSERT INTO idempotency(instance,${sql("key")},kind,input_hash,outcome,expires_at) VALUES ('probe',${key},'message.created','hash','original',1900000000000)`;
		const body = "résumé ALPHA " + "large ".repeat(15000);
		const previous = JSON.stringify({ body: "earlier BETA" });
		yield* sql`INSERT INTO messages(id,seq,topic,agent,instance,body,tags,meta,created_at,previous) VALUES ('m_probe',1,'test','probe','probe',${body},'[]','{}',1800000000000,${previous})`;
		yield* initializeRemoteCore(sql, "core-probe");
		assert.equal((yield* sql`SELECT migration_id FROM core_migrations`).length, 10);
		assert.deepEqual(yield* sql`SELECT updated_seq,mentions,previous_mentions,created_at FROM messages`, [
			{ updated_seq: 0, mentions: "[]", previous_mentions: "[]", created_at: 1800000000000 },
		]);
		const receipt = yield* sql`SELECT ${sql("key")},key_hash,outcome FROM idempotency`;
		assert.deepEqual(receipt, [{ key, key_hash: createHash("sha256").update(key).digest("hex"), outcome: "original" }]);
		assert.equal((yield* sql`SELECT body FROM messages`)[0]?.body, body);
		const current = yield* settings.engine === "pg"
			? sql`SELECT id FROM messages WHERE body_tsv @@ plainto_tsquery('simple','alpha')`
			: sql`SELECT id FROM messages WHERE MATCH(body) AGAINST ('+ALPHA +resume' IN BOOLEAN MODE)`;
		const prior = yield* settings.engine === "pg"
			? sql`SELECT id FROM messages WHERE previous_body_tsv @@ plainto_tsquery('simple','earlier')`
			: sql`SELECT id FROM messages WHERE MATCH(previous_body) AGAINST ('+earlier' IN BOOLEAN MODE)`;
		assert.deepEqual(current, [{ id: "m_probe" }]);
		assert.deepEqual(prior, [{ id: "m_probe" }]);
		const duplicate =
			yield* sql`INSERT INTO idempotency(instance,${sql("key")},kind,input_hash,outcome,expires_at) VALUES ('probe',${key},'message.created','hash','replacement',1900000000000)`.pipe(
				Effect.result,
			);
		assert.equal(duplicate._tag, "Failure");
		assert.deepEqual(yield* sql`SELECT outcome FROM idempotency`, [{ outcome: "original" }]);
		const invalid =
			yield* sql`INSERT INTO topic_page_continuations(seq,from_path,to_path,marker,completed) VALUES (1,'a','b','m',2)`.pipe(
				Effect.result,
			);
		assert.equal(invalid._tag, "Failure");
	}).pipe(Effect.scoped, Effect.provide(layer)),
);
// Closing the first scope releases its physical connections before this reader reopens the store.
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient;
		yield* initializeRemoteCore(sql, "core-probe");
		assert.equal((yield* sql`SELECT body FROM messages`)[0]?.body, "résumé ALPHA " + "large ".repeat(15000));
		assert.deepEqual(yield* sql`SELECT outcome FROM idempotency`, [{ outcome: "original" }]);
		assert.equal((yield* sql`SELECT migration_id FROM core_migrations`).length, 10);
	}).pipe(Effect.scoped, Effect.provide(layer)),
);
process.stdout.write("core native defaults, long values, receipt hashes, search and reconnect durability passed\n");
