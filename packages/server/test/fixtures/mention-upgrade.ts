import { strict as assert } from "node:assert";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { remoteMigrate } from "@comms/storage/remote-migrations";
import { testStore } from "./test-store.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { remoteCoreSteps } from "../../src/ext/core/core-schema-remote.ts";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
import { writerGate } from "../../src/kernel/database.ts";
import { BootChannel } from "../../src/kernel/boot-channel.ts";
const engine = Schema.decodeUnknownSync(Schema.Literals(["sqlite", "pglite", "pg", "mysql"]))(process.argv[2]);
const unavailable = () => Effect.die("Unexpected boot call");
const boot: BootChannel["Service"] = {
	epoch: "mention-upgrade",
	filename: null,
	store: { _tag: "file", filename: "/unused/app.db" },
	generation: 1,
	backup: unavailable(),
	fence: unavailable(),
	changed: unavailable,
	events: unavailable,
	reserve: unavailable,
	append: unavailable,
	abort: unavailable,
};
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* testStore({
			engine,
			config: process.env.COMMS_MENTION_UPGRADE_CONFIG,
			database: process.env.COMMS_MENTION_UPGRADE_DATABASE ?? "unused",
			tables: [],
		});
		yield* Effect.gen(function* () {
			yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch VARCHAR(64) NOT NULL)`;
			yield* sql`INSERT INTO kernel_writer VALUES(1,'mention-upgrade')`;
			yield* sql`CREATE TABLE mutation_batches(id VARCHAR(128) PRIMARY KEY,from_seq BIGINT,to_seq BIGINT,count BIGINT)`;
			yield* sql`CREATE TABLE outbox(seq BIGINT PRIMARY KEY,transaction_id VARCHAR(128),event TEXT,shipped_at BIGINT)`;
			if (engine === "mysql")
				yield* sql`CREATE TABLE kernel_migration_intent(singleton INTEGER PRIMARY KEY CHECK(singleton=1),scope VARCHAR(255) NOT NULL,name VARCHAR(255) NOT NULL,epoch VARCHAR(128) NOT NULL) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`;
			yield* initializeRemoteKernelSchema(sql, boot.epoch);
			// Empty, already-correct stores must be able to record the data-only rung.
			yield* initialize;
			assert.deepEqual(yield* sql`SELECT name FROM core_migrations WHERE migration_id=13`, [
				{ name: "mention_symbol_boundaries" },
			]);
			// Reconstruct the historical core12 fixture, including its pre-provenance registry shape.
			yield* sql`ALTER TABLE protected_sql_tables DROP COLUMN extension`;
			yield* sql`ALTER TABLE protected_sql_tables DROP COLUMN migration`;
			yield* sql`DELETE FROM core_migrations WHERE migration_id>=13`;
			if (engine === "sqlite") yield* sql`PRAGMA user_version=12`;
			const prefix = yield* sql`SELECT * FROM core_migrations ORDER BY migration_id`;
			for (let index = 0; index < 257; index++) {
				const id = `m_${String(index).padStart(4, "0")}`;
				const body = "~~@codex~~ https://host/@ignored <@alice>";
				const previous = '{ "body": "`@prior` mailto:@ignored", "untouched": [ null, "雪" ] }';
				yield* sql`INSERT INTO messages(id,seq,topic,agent,instance,body,tags,meta,created_at,previous,mentions,previous_mentions) VALUES(${id},${index + 1},'retained','agent','instance',${body},'[]','{}',1,${previous},'["@ignored"]','[]')`;
			}
			yield* sql`INSERT INTO idempotency(instance,${sql("key")},kind,input_hash,outcome,expires_at) VALUES('instance','key','message.created','hash','{ "literal": "receipt" }',1900000000000)`;
			yield* sql`INSERT INTO outbox VALUES(1,'retained','{ "literal": "event" }',NULL)`;
			const messages = yield* sql`SELECT id,seq,body,previous,created_at FROM messages ORDER BY id`;
			const receipts = yield* sql`SELECT * FROM idempotency`;
			const events = yield* sql`SELECT * FROM outbox`;
			if (engine === "sqlite") {
				const failed = yield* sql
					.withTransaction(initialize.pipe(Effect.andThen(Effect.fail("after_reindex"))))
					.pipe(Effect.result);
				assert.equal(failed._tag, "Failure");
			} else {
				const steps = remoteCoreSteps(sql).map((step) =>
					step.id !== 13
						? step
						: {
								...step,
								operations: step.operations.map((operation) => ({
									...operation,
									run: operation.run.pipe(Effect.andThen(Effect.fail("after_reindex"))),
								})),
							},
				);
				const failed = yield* remoteMigrate(sql, "core_migrations", steps, writerGate(sql, boot.epoch)).pipe(
					Effect.result,
				);
				assert.equal(failed._tag, "Failure");
				if (failed._tag === "Failure") assert.equal(failed.failure, "after_reindex");
			}
			assert.deepEqual(yield* sql`SELECT * FROM core_migrations ORDER BY migration_id`, prefix);
			assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM messages WHERE mentions='["@ignored"]'`, [
				{ count: 257 },
			]);
			yield* initialize;
			assert.deepEqual(yield* sql`SELECT * FROM core_migrations WHERE migration_id<13 ORDER BY migration_id`, prefix);
			assert.deepEqual(
				yield* sql`SELECT COUNT(*) AS count FROM messages WHERE mentions='["@codex","@alice"]' AND previous_mentions='["@prior"]'`,
				[{ count: 257 }],
			);
			assert.deepEqual(yield* sql`SELECT id,seq,body,previous,created_at FROM messages ORDER BY id`, messages);
			assert.deepEqual(yield* sql`SELECT * FROM idempotency`, receipts);
			assert.deepEqual(yield* sql`SELECT * FROM outbox`, events);
			// Replaying the data migration with an already-correct populated board is safe too.
			// Reconstruct the historical core12 fixture, including its pre-provenance registry shape.
			yield* sql`ALTER TABLE protected_sql_tables DROP COLUMN extension`;
			yield* sql`ALTER TABLE protected_sql_tables DROP COLUMN migration`;
			yield* sql`DELETE FROM core_migrations WHERE migration_id>=13`;
			if (engine === "sqlite") yield* sql`PRAGMA user_version=12`;
			yield* initialize;
			yield* initialize;
			assert.deepEqual(yield* sql`SELECT name FROM core_migrations WHERE migration_id=13`, [
				{ name: "mention_symbol_boundaries" },
			]);
		}).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provideService(BootChannel, boot));
	}).pipe(Effect.provide(Layer.merge(BunServices.layer, Reactivity.layer)), Effect.scoped),
);
process.stdout.write("MENTION_UPGRADE_VERIFIED\n");
