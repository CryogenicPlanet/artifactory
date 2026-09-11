import assert from "node:assert/strict";
import { BunRuntime } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Schema } from "effect";
import { SqlClient, Statement } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { Events, layer } from "../../src/events.ts";

const main = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	return yield* Effect.gen(function* () {
		const events = yield* Events;
		for (const [type, actor, instance, topic, level] of [
			["http.request", "other", "other-family", "a/child", "info"],
			["message.created", "codex", "caller", "a/child", "info"],
			["message.edited", "other", null, "a/child", "warn"],
			["message.created", "other", "other-family", "ab/child", "info"],
			["ext.failed", "other", "other-family", "a_b/child", "error"],
			["ext.loaded", "other", "other-family", "axb/child", "info"],
		] as const) {
			yield* events.writeBoot({
				at: 1,
				type,
				actor,
				instance,
				topic,
				level,
				generation: 1,
				request_id: null,
				message_id: null,
				payload: {},
			});
		}
		const query = (input: Omit<Parameters<typeof events.query>[0], "since" | "limit">, limit = 1, since = 0) =>
			events.query({ ...input, limit, since });
		assert.deepEqual(yield* query({ topic: "a", requestActor: "codex", excludeMessageInstance: "caller" }), {
			items: [(yield* query({ level: "warn" })).items[0]],
			cursor: 6,
			timed_out: false,
			drained: false,
		});
		assert.deepEqual(
			(yield* query({ topic: "a_b" })).items.map((item) => item.seq),
			[5],
		);
		assert.deepEqual(
			(yield* query({ types: ["message.*", "ext.failed"], agent: "other" }, 2)).items.map((item) => item.seq),
			[3, 4],
		);
		assert.equal((yield* query({ types: ["message.*", "ext.failed"], agent: "other" }, 2)).cursor, 4);
		assert.equal((yield* query({ types: ["message.*", "ext.failed"], agent: "other" }, 2, 4)).cursor, 6);
		assert.deepEqual(
			(yield* query({ instance: "other-family", level: "error" })).items.map((item) => item.seq),
			[5],
		);
		assert.equal((yield* query({ types: ["MESSAGE.*"] })).cursor, 6);
		assert.deepEqual((yield* query({ types: ["message?"] })).items, []);
		assert.deepEqual((yield* query({ types: ["message?*"] })).items, []);
		assert.equal((yield* query({ types: ["*"] })).cursor, 1);
		assert.equal((yield* query({ types: ["absent"] })).cursor, 6);
		const pending = yield* events.reserve("pending", 1, "attempt");
		yield* events.writeBoot({
			at: 1,
			type: "ext.failed",
			actor: "other",
			instance: null,
			topic: null,
			level: "error",
			generation: 1,
			request_id: null,
			message_id: null,
			payload: {},
		});
		assert.equal((yield* query({ types: ["absent"] })).cursor, 6);
		yield* events.abort(pending.transaction, "attempt");
		assert.equal((yield* query({ types: ["absent"] })).cursor, 8);
		// Verify the actual compiled query uses an index for every selective common filter.
		for (const [input, index] of [
			[{ agent: "codex" }, "events_actor_seq"],
			[{ instance: "caller" }, "events_instance_seq"],
			[{ level: "warn" }, "events_level_seq"],
			[{ types: ["message.created"] }, "events_type_seq"],
			[{ types: ["message.*"] }, "events_type_seq"],
			[{ topic: "a" }, "events_topic_seq"],
		] as const) {
			const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
			yield* query(input).pipe(
				Effect.provideService(Statement.CurrentTransformer, (statement) =>
					Effect.sync(() => {
						const compiled = statement.compile();
						if (compiled[0].startsWith("SELECT event,topic")) statements.push(compiled);
						return statement;
					}),
				),
			);
			assert.equal(statements.length, 1);
			for (const [text, parameters] of statements) {
				const plan = yield* sql
					.unsafe(`EXPLAIN QUERY PLAN ${text}`, parameters)
					.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ detail: Schema.String })))));
				assert.ok(
					plan.some((row) => row.detail.includes(index)),
					`${index}: ${plan.map((row) => row.detail).join(", ")}`,
				);
				assert.ok(plan.every((row) => !row.detail.includes("SCAN events")));
				assert.ok(!text.includes("json_extract"));
			}
		}
		for (const since of [7, 8]) {
			const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
			const page = yield* query({ topic: "a" }, 1, since).pipe(
				Effect.provideService(Statement.CurrentTransformer, (statement) =>
					Effect.sync(() => {
						const compiled = statement.compile();
						if (compiled[0].startsWith("SELECT event,topic")) statements.push(compiled);
						return statement;
					}),
				),
			);
			assert.equal(page.cursor, 8);
			assert.equal(statements.length, since === 8 ? 0 : 1);
			for (const [text, parameters] of statements) {
				const plan = yield* sql
					.unsafe(`EXPLAIN QUERY PLAN ${text}`, parameters)
					.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ detail: Schema.String })))));
				assert.ok(plan.some((row) => row.detail.includes("INTEGER PRIMARY KEY")));
			}
		}
		// Missing optional fields and JSON null project identically; routing remains independent.
		yield* sql`INSERT INTO events(seq,event,topic) VALUES(9,'{}','routed')`;
		assert.deepEqual(yield* sql`SELECT type,actor,instance,level,topic FROM events WHERE seq=9`, [
			{ type: null, actor: null, instance: null, level: null, topic: "routed" },
		]);
		yield* Console.log("event filters and indexes verified");
	}).pipe(Effect.provide(layer(Effect.void)));
}).pipe(Effect.scoped, Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })));
main.pipe(BunRuntime.runMain);
