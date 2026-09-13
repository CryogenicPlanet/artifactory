import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { remoteMigrate } from "@comms/storage/remote-migrations";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { initializeRemoteCore, remoteCoreSteps } from "../../src/ext/core/core-schema-remote.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const filename = process.env.COMMS_REMOTE_CORE_JSON_CRASH_CONFIG;
if (!filename) throw new Error("Missing disposable configuration");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
assert(settings.database.startsWith("comms_schema_"));
const options = {
	connection: { ...settings, password: Redacted.make(settings.password), tls: false },
	attempt: "c9".repeat(32),
};
const layer = remoteClientLayer({ ...options, register: () => Effect.void }).pipe(
	Layer.provide(remoteInspectorLayer(options)),
);
const tags = '[ "雪", "quoted" ]';
const meta = '{ "nested": { "nil": null, "value": "雪😀" } }';
const previous = '{ "body": "earlier", "tags": [ "old" ] }';
const receipt = '{ "id": "retained", "seq": 1 }';
const event = '{ "type": "retained", "payload": { "value": "雪" } }';
const mode = process.argv[2];
assert(mode === "crash" || mode === "recover" || mode === "verify");
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient;
		if (mode === "crash") {
			// Fresh disposable database only; no reset/drop path can affect an existing board.
			yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch VARCHAR(64) NOT NULL)`;
			yield* sql`INSERT INTO kernel_writer VALUES(1,'json-crash')`;
			yield* sql`CREATE TABLE outbox(seq BIGINT PRIMARY KEY,transaction_id VARCHAR(256) NOT NULL,event TEXT NOT NULL,shipped_at BIGINT)`;
			// This core-only fixture supplies the pre-core14 kernel registration table.
			yield* settings.engine === "pg"
				? sql`CREATE TABLE protected_sql_tables(name VARCHAR(128) PRIMARY KEY)`
				: sql`CREATE TABLE protected_sql_tables(name VARCHAR(128) PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`;
			yield* remoteMigrate(sql, "core_migrations", remoteCoreSteps(sql).slice(0, 10));
			yield* sql`INSERT INTO topics(path,name,meta,last_seq,created_at) VALUES('retained','Retained',${meta},1,1800000000000)`;
			yield* sql`INSERT INTO messages(id,seq,topic,agent,instance,body,tags,meta,created_at,previous) VALUES('retained',1,'retained','agent','instance','body',${tags},${meta},1800000000000,${previous})`;
			yield* sql`INSERT INTO idempotency(instance,${sql("key")},kind,input_hash,outcome,expires_at) VALUES('instance','retained','message.created','hash',${receipt},1900000000000)`;
			yield* sql`INSERT INTO outbox VALUES(1,'retained',${event},NULL)`;
			const steps = remoteCoreSteps(sql).map((step) =>
				step.id !== 11
					? step
					: {
							...step,
							operations: step.operations.map((operation, index) =>
								index !== 0
									? operation
									: {
											...operation,
											run: operation.run.pipe(
												Effect.andThen(Effect.sync(() => process.stdout.write("JSON_DDL_APPLIED\n"))),
												Effect.andThen(Effect.never),
											),
										},
							),
						},
			);
			yield* remoteMigrate(sql, "core_migrations", steps);
			return;
		}
		const types = () =>
			sql`SELECT data_type AS type FROM information_schema.columns WHERE table_schema=${settings.engine === "pg" ? "public" : settings.database} AND ((table_name='messages' AND column_name IN ('tags','meta')) OR (table_name='topics' AND column_name='meta')) ORDER BY table_name,column_name`;
		if (mode === "recover") {
			assert.equal((yield* sql`SELECT migration_id FROM core_migrations`).length, 10);
			assert.equal(
				(yield* types()).filter((row) => row.type === (settings.engine === "pg" ? "jsonb" : "json")).length,
				settings.engine === "pg" ? 0 : 1,
			);
			if (settings.engine === "mysql")
				assert.deepEqual(yield* sql`SELECT migration_id,name,operation,active FROM core_migrations_intent`, [
					{ migration_id: 11, name: "domain_json", operation: 0, active: "messages_tags_json" },
				]);
		}
		yield* initializeRemoteCore(sql, "json-crash");
		assert.equal((yield* sql`SELECT migration_id FROM core_migrations`).length, 14);
		assert.deepEqual(
			yield* types(),
			Array.from({ length: 3 }, () => ({ type: settings.engine === "pg" ? "jsonb" : "json" })),
		);
		const rows = yield* (
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
		assert.deepEqual(JSON.parse(rows[0]?.tags ?? "null"), JSON.parse(tags));
		assert.deepEqual(JSON.parse(rows[0]?.meta ?? "null"), JSON.parse(meta));
		const topic = yield* (
			settings.engine === "pg"
				? sql`SELECT meta::text AS meta FROM topics`
				: sql`SELECT CAST(meta AS CHAR) AS meta FROM topics`
		).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ meta: Schema.String })))));
		assert.deepEqual(JSON.parse(topic[0]?.meta ?? "null"), JSON.parse(meta));
		assert.equal(rows[0]?.previous, previous);
		assert.deepEqual(yield* sql`SELECT outcome FROM idempotency`, [{ outcome: receipt }]);
		assert.deepEqual(yield* sql`SELECT event FROM outbox`, [{ event }]);
		if (settings.engine === "mysql") assert.deepEqual(yield* sql`SELECT singleton FROM core_migrations_intent`, []);
		process.stdout.write("JSON_CRASH_RECOVERY_VERIFIED\n");
	}).pipe(Effect.scoped, Effect.provide(layer)),
);
