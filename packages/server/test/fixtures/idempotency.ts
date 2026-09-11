import { migrateIdempotency } from "../../src/ext/core/legacy-idempotency.ts";
import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Clock, Console, Crypto, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { EventRecord } from "../../src/kernel/boot-channel.ts";
import {
	type Idempotency,
	lookupIdempotency,
	operationalInput,
	storeIdempotency,
} from "../../src/kernel/idempotency.ts";

const program = Effect.gen(function* () {
	const mode = process.argv[2];
	const sql = yield* SqlClient.SqlClient;
	const crypto = yield* Crypto.Crypto;
	yield* sql`CREATE TABLE idempotency(instance TEXT,key TEXT,input TEXT,message_id TEXT,transaction_id TEXT,outcome TEXT,PRIMARY KEY(instance,key))`;
	yield* sql`CREATE TABLE topic_idempotency(instance TEXT,key TEXT,input TEXT,outcome TEXT,PRIMARY KEY(instance,key))`;
	yield* sql`CREATE TABLE read_idempotency(instance TEXT,key TEXT,topic TEXT,requested_seq INTEGER,effective_seq INTEGER,PRIMARY KEY(instance,key))`;
	yield* sql`CREATE TABLE reaction_idempotency(instance TEXT,key TEXT,message TEXT,emoji TEXT,outcome TEXT,PRIMARY KEY(instance,key))`;
	yield* sql`CREATE TABLE outbox(seq INTEGER PRIMARY KEY,transaction_id TEXT,event TEXT,shipped_at INTEGER)`;
	const json = Schema.fromJsonString(Schema.Json);
	const receipt = (kind: string, input: string, key = "shared"): Idempotency<Schema.Json> => ({
		instance: "instance",
		kind,
		input,
		key,
		outcome: json,
	});
	const lookup = (value: Idempotency<Schema.Json>) => sql.withTransaction(lookupIdempotency(sql, crypto, value));
	const rejected = (value: Idempotency<Schema.Json>) =>
		Effect.gen(function* () {
			const result = yield* lookup(value).pipe(Effect.result);
			assert.equal(result._tag, "Failure");
		});
	const firstInput = JSON.stringify({ topic: "topic", body: "hello", tags: [], meta: { a: 1, b: 2 } });
	const message = {
		id: "m_original",
		seq: 1,
		topic: "topic",
		agent: "agent",
		instance: "instance",
		body: "hello",
		tags: [],
		meta: { a: 1, b: 2 },
		created_at: 10,
		edited_at: null,
		deleted_at: null,
	};
	const topicInput = JSON.stringify({ path: "topic", input: { meta: { x: 1 } } });
	const topic = { path: "topic", meta: { x: 1 }, archived_at: null, seq: 2 };
	const reaction = { message: "m_original", emoji: "ok", instance: "instance", active: true, seq: 3 };
	const event = {
		seq: 4,
		at: 1,
		type: "ext.loaded",
		level: "info" as const,
		actor: "system",
		instance: null,
		generation: 2,
		request_id: null,
		topic: null,
		message_id: null,
		payload: { x: 1, y: 2 },
	};
	if (mode === "legacy" || mode === "malformed") {
		yield* sql`INSERT INTO idempotency VALUES('instance','shared',${firstInput},'m_original','tx',${mode === "malformed" ? "{}" : JSON.stringify(message)})`;
		yield* sql`INSERT INTO topic_idempotency VALUES('instance','shared',${topicInput},${JSON.stringify(topic)})`;
		yield* sql`INSERT INTO read_idempotency VALUES('instance','shared','',3,8)`;
		yield* sql`INSERT INTO reaction_idempotency VALUES('instance','shared','m_original','ok',${JSON.stringify(reaction)})`;
	}
	if (mode === "operational" || mode === "duplicate-conflict") {
		yield* sql`INSERT INTO outbox VALUES(4,${`ext:${"a".repeat(32)}:${"b".repeat(32)}`},${JSON.stringify(event)},NULL)`;
		yield* sql`INSERT INTO outbox VALUES(5,${`ext:${"a".repeat(32)}:${"c".repeat(32)}`},${JSON.stringify({ ...event, seq: 5, payload: mode === "duplicate-conflict" ? { changed: true } : event.payload })},NULL)`;
	}
	const variants = [
		{
			kind: "message.edited",
			input: JSON.stringify({ method: "PATCH", id: "m_original", input: { body: "edited" } }),
			outcome: { ...message, body: "edited", edited_at: 20 },
		},
		{
			kind: "message.deleted",
			input: JSON.stringify({ method: "DELETE", id: "m_original", input: null }),
			outcome: { ...message, deleted_at: 30 },
		},
		{
			kind: "topic.archived",
			input: JSON.stringify({ path: "topic", input: { archived: true } }),
			outcome: { ...topic, archived_at: 20 },
		},
		{
			kind: "topic.deleted",
			input: JSON.stringify({ path: "topic", delete: true }),
			outcome: { path: "topic", deleted_at: 30, seq: 3 },
		},
		{
			kind: "topic.moved",
			input: JSON.stringify({ from: "topic", to: "destination", move: true }),
			outcome: { from: "topic", to: "destination", seq: 4 },
		},
	];
	if (mode === "variants") {
		for (const item of variants) {
			if (item.kind.startsWith("message."))
				yield* sql`INSERT INTO idempotency VALUES('instance',${item.kind},${item.input},'m_original','tx',${JSON.stringify(item.outcome)})`;
			else
				yield* sql`INSERT INTO topic_idempotency VALUES('instance',${item.kind},${item.input},${JSON.stringify(item.outcome)})`;
		}
	}
	const adoptedAt = yield* Clock.currentTimeMillis;
	const migration = yield* sql.withTransaction(migrateIdempotency(sql)).pipe(Effect.result);
	if (mode === "malformed" || mode === "duplicate-conflict") {
		assert.equal(migration._tag, "Failure");
		// Renames, new table, imported receipts and drops all roll back together.
		assert.equal((yield* sql`SELECT name FROM sqlite_master WHERE name='idempotency_legacy'`).length, 0);
		assert.equal((yield* sql`SELECT name FROM sqlite_master WHERE name='topic_idempotency'`).length, 1);
		yield* sql`SELECT message_id,transaction_id FROM idempotency`;
	} else {
		if (migration._tag === "Failure") return yield* migration.failure;
		assert.equal(
			(yield* sql`SELECT name FROM sqlite_master WHERE name IN ('idempotency_legacy','topic_idempotency','read_idempotency','reaction_idempotency')`)
				.length,
			0,
		);
		const expiryRows = yield* sql`SELECT expires_at FROM idempotency`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ expires_at: Schema.Int })))),
		);
		for (const row of expiryRows) assert.ok(row.expires_at >= adoptedAt + 30 * 86400000);
		assert.equal(
			(yield* sql`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idempotency_expiry','outbox_unshipped','outbox_transaction')`)
				.length,
			3,
		);
		if (mode === "variants") {
			for (const item of variants)
				assert.deepEqual(Option.getOrThrow(yield* lookup(receipt(item.kind, item.input, item.kind))), item.outcome);
			assert.equal((yield* sql`SELECT * FROM idempotency`).length, 5);
		} else if (mode === "legacy") {
			assert.equal((yield* sql`SELECT * FROM idempotency`).length, 4);
			assert.deepEqual(Option.getOrThrow(yield* lookup(receipt("message.created", firstInput))), message);
			assert.deepEqual(Option.getOrThrow(yield* lookup(receipt("topic.meta", topicInput))), topic);
			assert.deepEqual(
				Option.getOrThrow(yield* lookup(receipt("read.marked", JSON.stringify({ topic: "", seq: 3 })))),
				{ topic: "*", seq: 8 },
			);
			assert.deepEqual(
				Option.getOrThrow(
					yield* lookup(receipt("reaction.added", JSON.stringify({ message: "m_original", emoji: "ok" }))),
				),
				reaction,
			);
			yield* rejected(
				receipt("message.created", JSON.stringify({ topic: "topic", body: "hello", tags: [], meta: { b: 2, a: 1 } })),
			);
			yield* rejected(receipt("message.deleted", firstInput));
			yield* rejected(receipt("sql.write", "new write"));
			yield* rejected(receipt("topic.meta", JSON.stringify({ path: "topic", input: { meta: { x: 2 } } })));
			assert.equal((yield* sql`SELECT * FROM idempotency`).length, 4);
		} else if (mode === "operational") {
			const internal: Idempotency<typeof EventRecord.Type> = {
				instance: "",
				key: "a".repeat(32),
				scope: "operational",
				kind: event.type,
				input: operationalInput(event),
				outcome: Schema.fromJsonString(EventRecord),
			};
			assert.deepEqual(Option.getOrThrow(yield* lookupIdempotency(sql, crypto, internal)), event);
			yield* sql`DELETE FROM outbox`;
			assert.deepEqual(Option.getOrThrow(yield* lookupIdempotency(sql, crypto, internal)), event);
			const conflict = yield* lookupIdempotency(sql, crypto, {
				...internal,
				input: operationalInput({ ...event, generation: 3 }),
			}).pipe(Effect.result);
			assert.equal(conflict._tag, "Failure");
			assert.equal((yield* sql`SELECT * FROM idempotency`).length, 1);
		} else {
			for (const key of [
				"normal",
				'["key","normal"]',
				'["legacy","message","normal"]',
				'["operational","normal"]',
				'quotes" and\\slashes',
			]) {
				const value = receipt("message.created", firstInput, key);
				yield* sql.withTransaction(
					Effect.gen(function* () {
						assert(Option.isNone(yield* lookupIdempotency(sql, crypto, value)));
						yield* storeIdempotency(sql, crypto, value, message);
					}),
				);
				assert.deepEqual(Option.getOrThrow(yield* lookup(value)), message);
				yield* rejected({ ...value, kind: "topic.meta" });
			}
			assert.equal((yield* sql`SELECT * FROM idempotency`).length, 5);
		}
	}
	yield* Console.log(`IDEMPOTENCY_${mode}_OK`);
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped, Effect.provide(BunServices.layer));
BunRuntime.runMain(program);
