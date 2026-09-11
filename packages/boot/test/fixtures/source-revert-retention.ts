import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Clock, Console, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HttpServerResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { acceptSourceRevert, sourceReverts } from "../../src/source-revert.ts";

const day = 86_400_000;
const rowSchema = Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }));
const recordSchema = Schema.fromJsonString(
	Schema.Struct({
		created_at: Schema.optionalKey(Schema.Int),
		completed_at: Schema.optionalKey(Schema.NullOr(Schema.Int)),
		outcome: Schema.NullOr(Schema.Json),
	}),
);
const main = Effect.gen(function* () {
	const root = process.argv[2],
		scenario = process.argv[3];
	if (!root) return yield* Effect.die("Missing root");
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		const sql = yield* SqlClient.SqlClient;
		const records = sql`SELECT key,value FROM settings WHERE key LIKE 'source-revert-result:%' ORDER BY key`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(rowSchema)),
		);
		const put = (key: string, value: Schema.Json) =>
			sql`INSERT INTO settings(key,value) VALUES(${`source-revert-result:${key}`},${JSON.stringify(value)})`;
		const terminal = {
			selector: "test",
			page_batch: null,
			outcome: { status: 200, body: { generation: 1, status: "live" } },
		};
		yield* TestClock.setTime(1000);
		const service = yield* sourceReverts;
		if (scenario === "clock") {
			let calls = 0;
			const operation = (id: string) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							calls++;
							yield* acceptSourceRevert(id, calls);
							return HttpServerResponse.jsonUnsafe({ generation: calls, status: "live" });
						}),
					)
					.pipe(Effect.orDie);
			const call = (reverts: typeof service) =>
				reverts.run({ family: "human", key: "undo" }, "selector", Effect.void, operation);
			const first = yield* call(service);
			const firstRows = yield* records;
			assert.equal(firstRows.length, 1);
			const saved = yield* Schema.decodeEffect(recordSchema)(firstRows[0]?.value ?? "");
			assert.equal(saved.created_at, 1000);
			assert.equal(saved.completed_at, 1000);
			yield* TestClock.adjust("20 days");
			// A fresh scoped service simulates restart; newer source state must not cause another operation.
			const restarted = yield* sourceReverts;
			const replay = yield* call(restarted);
			assert.deepEqual(replay.body, first.body);
			assert.equal(calls, 1);
			yield* TestClock.adjust("10 days");
			assert.equal(yield* restarted.prune, 0);
			yield* TestClock.adjust("1 millis");
			assert.equal(yield* restarted.prune, 1);
			yield* call(restarted);
			assert.equal(calls, 2);
		} else if (scenario === "legacy") {
			yield* put("legacy", terminal);
			assert.equal(yield* service.prune, 0);
			const stamped = yield* Schema.decodeEffect(recordSchema)((yield* records)[0]?.value ?? "");
			assert.equal(stamped.completed_at, 1000);
			yield* TestClock.adjust("29 days");
			const restarted = yield* sourceReverts;
			assert.equal(yield* restarted.prune, 0);
			yield* TestClock.adjust("1 day");
			assert.equal(yield* restarted.prune, 0);
			yield* TestClock.adjust("1 millis");
			assert.equal(yield* restarted.prune, 1);
		} else if (scenario === "pending") {
			yield* put("pending", { ...terminal, outcome: null, created_at: 0, completed_at: 0 });
			yield* put("missing-page", { ...terminal, page_batch: "missing", completed_at: 0 });
			yield* put("page-pending", { ...terminal, outcome: null, page_batch: "publishing", completed_at: 0 });
			yield* put("terminal", { ...terminal, completed_at: 0 });
			yield* sql`INSERT INTO source_batches(id,lock_id,agent,at,state) VALUES('publishing',NULL,'human',0,'publishing')`;
			yield* TestClock.adjust("31 days");
			assert.equal(yield* service.prune, 0);
			yield* sql`UPDATE source_batches SET state='published' WHERE id='publishing'`;
			yield* sql`INSERT INTO cutover(singleton,candidate,lock_id,family,phase) VALUES(1,1,'held','human','accepted')`;
			assert.equal(yield* service.prune, 0);
			yield* sql`DELETE FROM cutover`;
			assert.equal(yield* service.prune, 1);
			assert.equal((yield* records).length, 3);
		} else if (scenario === "bounded") {
			for (let i = 0; i < 260; i++) yield* put(String(i).padStart(4, "0"), { ...terminal, completed_at: 0 });
			yield* TestClock.adjust("31 days");
			assert.equal(yield* service.prune, 256);
			assert.equal((yield* records).length, 4);
			assert.equal(yield* service.prune, 4);
		} else if (scenario === "accept-rollback") {
			const pending = { ...terminal, outcome: null, created_at: 1000, completed_at: null };
			yield* put("rollback", pending);
			const exit = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						yield* acceptSourceRevert("source-revert-result:rollback", 7);
						return yield* Effect.fail("rollback");
					}),
				)
				.pipe(Effect.exit);
			assert.equal(exit._tag, "Failure");
			const saved = yield* Schema.decodeEffect(recordSchema)((yield* records)[0]?.value ?? "");
			assert.equal(saved.completed_at, null);
			assert.equal(saved.outcome, null);
		} else if (scenario === "restart-seed") {
			yield* put("restart", { ...terminal, completed_at: 1000, created_at: 1000 });
		} else if (scenario === "restart-prune") {
			yield* TestClock.setTime(1000 + 30 * day);
			assert.equal(yield* service.prune, 0);
			yield* TestClock.adjust("1 millis");
			assert.equal(yield* service.prune, 1);
		} else throw Error("Unknown scenario");
		yield* Console.log(`retention ${scenario} passed ${yield* Clock.currentTimeMillis}`);
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db` })), Effect.provide(TestClock.layer()));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
