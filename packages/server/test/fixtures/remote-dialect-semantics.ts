import { BunServices } from "@effect/platform-bun";
import { strict as assert } from "node:assert";
import { Effect, Layer, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { testStore } from "./test-store.ts";
import { dialectSemantics } from "./dialect-semantics.ts";
import { on } from "@comms/storage/dialect";
import { readIsolationSemantics } from "./read-isolation-semantics.ts";
import { publishedImageSemantics } from "./published-image-semantics.ts";
import { moveTopic } from "../../src/ext/core/topic-move.ts";
import type { Mutate } from "../../src/kernel/mutate.ts";

async function main() {
	const engine = Schema.decodeUnknownSync(Schema.Literals(["sqlite", "pg", "mysql"]))(
		process.env.COMMS_TEST_ENGINE ?? "sqlite",
	);
	let phase = "connect";
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* testStore({
					engine,
					config: process.env.COMMS_TEST_STORE_CONFIG,
					database: "comms_shared_store",
					tables: ["topic_page_continuations", "reads", "messages", "topics", "kv", "kernel_writer"],
				});
				phase = "dialect fragments";
				yield* dialectSemantics(sql);
				phase = "read site transaction isolation";
				yield* readIsolationSemantics(sql);
				phase = "topic move setup";
				const json = on(sql, { sqlite: () => sql`TEXT`, pg: () => sql`JSONB`, mysql: () => sql`JSON` });
				yield* sql`CREATE TABLE topics(path VARCHAR(200) PRIMARY KEY,parent VARCHAR(200),name VARCHAR(200),meta ${json},previous ${json},last_seq BIGINT,created_at BIGINT,updated_seq BIGINT,archived_at BIGINT,deleted_at BIGINT)`;
				yield* sql`CREATE TABLE messages(topic VARCHAR(200),seq BIGINT,id VARCHAR(200),agent VARCHAR(200),instance VARCHAR(200),created_at BIGINT,body TEXT,tags ${json},meta ${json},previous ${json},updated_seq BIGINT,edited_at BIGINT,deleted_at BIGINT)`;
				yield* sql`CREATE TABLE ${sql("reads")}(instance VARCHAR(200),topic VARCHAR(200),seq BIGINT,PRIMARY KEY(instance,topic))`;
				yield* sql`CREATE TABLE topic_page_continuations(seq BIGINT,from_path VARCHAR(200),to_path VARCHAR(200),marker VARCHAR(200),completed INTEGER)`;
				yield* sql`INSERT INTO topics(path,parent,name,meta,last_seq,created_at,updated_seq) VALUES('old',NULL,'old','{}',10,0,0),('old/child','old','child','{}',10,0,0)`;
				yield* sql`INSERT INTO messages(topic,seq) VALUES('old',8),('old/child',10)`;
				yield* sql`INSERT INTO ${sql("reads")} VALUES('source-higher','old',12),('source-higher','new',4),('destination-higher','old/child',3),('destination-higher','new/child',15),('only-source','old',7),('unrelated','oldish',9)`;
				// Exercise the actual production move body; reservation/publication are independently tested.
				const mutate: Mutate = (input) =>
					sql.withTransaction(
						input.body(() => Effect.succeed({ from: 20, to: 20 })).pipe(Effect.map((result) => result.outcome)),
					);
				phase = "transaction rollback";
				const rollback = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* sql`UPDATE topics SET name='uncommitted' WHERE path='old'`;
							yield* sql`INSERT INTO ${sql("reads")} VALUES('rolled-back','old',99)`;
							return yield* Effect.fail("forced rollback");
						}),
					)
					.pipe(Effect.result);
				assert.equal(rollback._tag, "Failure");
				if (rollback._tag === "Failure") assert.equal(rollback.failure, "forced rollback");
				assert.deepEqual(yield* sql`SELECT name FROM topics WHERE path='old'`, [{ name: "old" }]);
				assert.equal((yield* sql`SELECT * FROM ${sql("reads")} WHERE instance='rolled-back'`).length, 0);
				phase = "production topic move with cursor collisions";
				yield* moveTopic(
					sql,
					mutate,
					{ generation: 1 },
					{ agent: "test", instance: "test", request: "test", kind: "agent" },
					"old",
					"new",
					{ prepare: () => Effect.succeed(false), finish: () => Effect.succeed(undefined) },
				);
				assert.deepEqual(yield* sql`SELECT instance,topic,seq FROM ${sql("reads")} ORDER BY instance,topic`, [
					{ instance: "destination-higher", topic: "new/child", seq: 15 },
					{ instance: "only-source", topic: "new", seq: 7 },
					{ instance: "source-higher", topic: "new", seq: 12 },
					{ instance: "unrelated", topic: "oldish", seq: 9 },
				]);
				assert.deepEqual(yield* sql`SELECT topic,seq FROM messages ORDER BY seq`, [
					{ topic: "new", seq: 8 },
					{ topic: "new/child", seq: 10 },
				]);
				phase = "native JSON published image CTEs";
				yield* publishedImageSemantics(sql);
				phase = "text column published image CTEs";
				yield* sql`DELETE FROM messages WHERE id='json-probe'`;
				yield* sql`DELETE FROM topics WHERE path='json-probe'`;
				yield* on(sql, {
					sqlite: () => sql`SELECT 1`,
					pg: () => sql`ALTER TABLE topics ALTER COLUMN meta TYPE TEXT USING meta::text`,
					mysql: () => sql`ALTER TABLE topics MODIFY meta TEXT`,
				});
				yield* on(sql, {
					sqlite: () => sql`SELECT 1`,
					pg: () =>
						sql`ALTER TABLE messages ALTER COLUMN tags TYPE TEXT USING tags::text, ALTER COLUMN meta TYPE TEXT USING meta::text`,
					mysql: () => sql`ALTER TABLE messages MODIFY tags TEXT, MODIFY meta TEXT`,
				});
				yield* publishedImageSemantics(sql);
			}).pipe(Effect.provide(Layer.merge(Reactivity.layer, BunServices.layer)), Effect.scoped),
		);
		process.stdout.write("SHARED_STORE_VERIFIED\n");
	} catch {
		throw new Error(`Shared store fixture failed during ${phase}`);
	}
}
await main();
