import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Effect, Layer, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { remoteMigrate, type RemoteStep } from "@comms/storage/remote-migrations";
import { CoreJsonSchemaError } from "../../src/ext/core/core-json-schema.ts";
import { initializeRemoteCore, remoteCoreSteps } from "../../src/ext/core/core-schema-remote.ts";
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
		// This core-only fixture supplies the pre-core14 kernel registration table.
		yield* settings.engine === "pg"
			? sql`CREATE TABLE protected_sql_tables(name VARCHAR(128) PRIMARY KEY)`
			: sql`CREATE TABLE protected_sql_tables(name VARCHAR(128) PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`;

		yield* remoteMigrate(sql, "core_migrations", remoteCoreSteps(sql).slice(0, 10));
		const key = JSON.stringify(["key", '"\\'.repeat(200) + "héllo\\x雪😀"]);
		yield* sql`INSERT INTO idempotency(instance,${sql("key")},kind,input_hash,outcome,expires_at) VALUES ('probe',${key},'message.created','hash','original',1900000000000)`;
		const body = "résumé ALPHA ~~@codex~~ https://host/@ignored " + "large ".repeat(15000);
		const previous = JSON.stringify({ body: "earlier BETA `@prior` mailto:@ignored" });
		yield* sql`INSERT INTO messages(id,seq,topic,agent,instance,body,tags,meta,created_at,previous) VALUES ('m_probe',1,'test','probe','probe',${body},'[]','{}',1800000000000,${previous})`;
		yield* sql`INSERT INTO topics(path,name,meta,last_seq,created_at) VALUES ('test','Test','[]',1,1800000000000)`;
		const invalidJson = yield* initializeRemoteCore(sql, "core-probe").pipe(Effect.result);
		assert(Result.isFailure(invalidJson));
		assert(Schema.is(CoreJsonSchemaError)(invalidJson.failure));
		assert.equal(invalidJson.failure.code, "core_json_invalid");
		const types = () =>
			sql`SELECT data_type AS type FROM information_schema.columns WHERE table_schema=${settings.engine === "pg" ? "public" : settings.database} AND ((table_name='messages' AND column_name IN ('tags','meta')) OR (table_name='topics' AND column_name='meta')) ORDER BY table_name,column_name`;
		assert.deepEqual(
			yield* types(),
			Array.from({ length: 3 }, () => ({ type: settings.engine === "pg" ? "text" : "longtext" })),
		);
		// Later-column drift must refuse before earlier MySQL ALTERs commit.
		yield* settings.engine === "pg"
			? sql`ALTER TABLE topics ALTER COLUMN meta DROP NOT NULL`
			: sql`ALTER TABLE topics MODIFY COLUMN meta LONGTEXT NULL`;
		const invalidShape = yield* initializeRemoteCore(sql, "core-probe").pipe(Effect.result);
		assert(Result.isFailure(invalidShape));
		assert(Schema.is(CoreJsonSchemaError)(invalidShape.failure));
		assert.equal(invalidShape.failure.code, "core_json_shape_invalid");
		assert.deepEqual(
			yield* types(),
			Array.from({ length: 3 }, () => ({ type: settings.engine === "pg" ? "text" : "longtext" })),
		);
		yield* settings.engine === "pg"
			? sql`ALTER TABLE topics ALTER COLUMN meta SET NOT NULL`
			: sql`ALTER TABLE topics MODIFY COLUMN meta LONGTEXT NOT NULL`;
		const domainMeta = JSON.stringify({ nested: { nullable: null, quote: '"雪😀\\' }, list: [1, true] });
		yield* sql`UPDATE topics SET meta=${domainMeta}`;
		yield* sql`UPDATE messages SET tags='["雪","quoted"]',meta=${domainMeta}`;
		// Fail after actual DDL but before progress is recorded. MySQL must recognize the owned
		// completed ALTER on replay; PostgreSQL must roll the whole migration back.
		for (const stop of settings.engine === "mysql" ? [0, 1, 2] : [0]) {
			const steps: ReadonlyArray<RemoteStep<Effect.Error<ReturnType<typeof initializeRemoteCore>> | string>> =
				remoteCoreSteps(sql).map((step) =>
					step.id !== 11
						? step
						: {
								...step,
								operations: step.operations.map((operation, index) =>
									index !== stop
										? operation
										: {
												...operation,
												run: operation.run.pipe(Effect.andThen(Effect.fail("injected_after_json_ddl"))),
											},
								),
							},
				);
			const interrupted = yield* remoteMigrate(sql, "core_migrations", steps).pipe(Effect.result);
			assert(Result.isFailure(interrupted));
			assert.equal(interrupted.failure, "injected_after_json_ddl");
			assert.equal((yield* sql`SELECT migration_id FROM core_migrations`).length, 10);
			const expectedConverted = settings.engine === "mysql" ? stop + 1 : 0;
			assert.equal(
				(yield* types()).filter((row) => row.type === (settings.engine === "pg" ? "jsonb" : "json")).length,
				expectedConverted,
			);
		}
		yield* initializeRemoteCore(sql, "core-probe");
		assert.deepEqual(
			yield* types(),
			Array.from({ length: 3 }, () => ({ type: settings.engine === "pg" ? "jsonb" : "json" })),
		);
		const values = yield* (
			settings.engine === "pg"
				? sql`SELECT tags::text AS tags,meta::text AS meta,previous FROM messages`
				: sql`SELECT CAST(tags AS CHAR) AS tags,CAST(meta AS CHAR) AS meta,previous FROM messages`
		).pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(Schema.Struct({ tags: Schema.String, meta: Schema.String, previous: Schema.String })),
				),
			),
		);
		assert.deepEqual(JSON.parse(values[0]?.tags ?? "null"), ["雪", "quoted"]);
		assert.deepEqual(JSON.parse(values[0]?.meta ?? "null"), JSON.parse(domainMeta));
		assert.equal(values[0]?.previous, previous);
		assert.equal((yield* sql`SELECT migration_id FROM core_migrations`).length, 14);
		assert.deepEqual(yield* sql`SELECT updated_seq,mentions,previous_mentions,created_at FROM messages`, [
			{ updated_seq: 0, mentions: '["@codex"]', previous_mentions: '["@prior"]', created_at: 1800000000000 },
		]);
		const receipt = yield* sql`SELECT ${sql("key")},key_hash,outcome FROM idempotency`;
		assert.deepEqual(receipt, [{ key, key_hash: createHash("sha256").update(key).digest("hex"), outcome: "original" }]);
		assert.equal((yield* sql`SELECT body FROM messages WHERE id='m_probe'`)[0]?.body, body);
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
		assert.equal(
			(yield* sql`SELECT body FROM messages WHERE id='m_probe'`)[0]?.body,
			"résumé ALPHA ~~@codex~~ https://host/@ignored " + "large ".repeat(15000),
		);
		assert.deepEqual(yield* sql`SELECT outcome FROM idempotency`, [{ outcome: "original" }]);
		assert.equal((yield* sql`SELECT migration_id FROM core_migrations`).length, 14);
		for (const [id, seq] of [
			["Case", 2],
			["case", 3],
		] as const) {
			yield* sql`INSERT INTO messages(id,seq,topic,agent,instance,body,tags,meta,created_at) VALUES (${id},${seq},'test','probe','probe','case probe','[]','{}',1)`;
			assert.deepEqual(yield* sql`SELECT id FROM messages WHERE id=${id}`, [{ id }]);
		}
		// Extensions may add columns/indexes; only the core identifier contract is fixed.
		yield* sql`ALTER TABLE messages ADD COLUMN extension_note TEXT`;
		yield* sql`CREATE INDEX extension_message_note ON messages(seq,created_at)`;
		yield* initializeRemoteCore(sql, "core-probe");
		if (settings.engine === "mysql") {
			yield* sql`ALTER TABLE messages MODIFY topic VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL`;
			const refused = yield* initializeRemoteCore(sql, "core-probe").pipe(Effect.result);
			assert.equal(refused._tag, "Failure");
			if (refused._tag === "Failure") {
				assert.ok("code" in refused.failure);
				assert.equal(refused.failure.code, "app_schema_unsupported");
			}
			assert.equal(
				(yield* sql`SELECT body FROM messages WHERE id='m_probe'`)[0]?.body,
				"résumé ALPHA ~~@codex~~ https://host/@ignored " + "large ".repeat(15000),
			);
		}
	}).pipe(Effect.scoped, Effect.provide(layer)),
);
process.stdout.write("core native defaults, long values, receipt hashes, search and reconnect durability passed\n");
