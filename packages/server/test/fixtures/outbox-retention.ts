import { migrateIdempotency } from "../../src/ext/core/legacy-idempotency.ts";
import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Clock, Console, Crypto, Effect, Option, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Events, eventsSchema, layer as eventsLayer } from "../../../boot/src/events.ts";
import { type BootChannel, type EventRecord, KernelError } from "../../src/kernel/boot-channel.ts";
import { lookupIdempotency } from "../../src/kernel/idempotency.ts";
import { makeMutate } from "../../src/kernel/mutate.ts";
import { makeOutboxRelay } from "../../src/kernel/outbox.ts";

const program = Effect.gen(function* () {
	const [root, mode] = process.argv.slice(2);
	if (!root || !mode) return yield* Effect.die("Missing fixture arguments");
	const day = 86400000;
	let now = 100 * day;
	const clock = yield* Clock.Clock;
	yield* Effect.gen(function* () {
		const bootSql = yield* SqlClient.SqlClient;
		yield* eventsSchema;
		yield* (yield* SqlClient.SqlClient)`ALTER TABLE events ADD COLUMN topic TEXT`;
		yield* Effect.gen(function* () {
			const events = yield* Events;
			let blocked = false;
			const error = () => new KernelError({ code: "boot_unavailable" });
			const boot: BootChannel["Service"] = {
				backup: Effect.void,
				changed: (after) => events.changed(after).pipe(Effect.mapError(error)),
				epoch: "writer",
				filename: `${root}/app.db`,
				generation: 1,
				fence: events.state.pipe(
					Effect.map(({ published_through }) => ({ published_through })),
					Effect.mapError(error),
				),
				events: (input) => events.query(input).pipe(Effect.mapError(error)),
				reserve: (id, count) => events.reserve(id, count, "writer").pipe(Effect.mapError(error)),
				abort: (id) => events.abort(id, "writer").pipe(Effect.mapError(error)),
				append: (batch) =>
					Effect.suspend(() =>
						blocked ? Effect.fail(error()) : events.append(batch, "writer").pipe(Effect.mapError(error)),
					),
			};
			yield* Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const crypto = yield* Crypto.Crypto;
				yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT NOT NULL)`;
				yield* sql`INSERT INTO kernel_writer VALUES(1,'writer')`;
				yield* sql`CREATE TABLE mutation_batches(id TEXT PRIMARY KEY,from_seq INTEGER,to_seq INTEGER,count INTEGER)`;
				yield* sql`CREATE TABLE outbox(seq INTEGER PRIMARY KEY,transaction_id TEXT,event TEXT,shipped_at INTEGER)`;
				yield* sql`CREATE TABLE idempotency(instance TEXT,key TEXT,input TEXT,outcome TEXT,PRIMARY KEY(instance,key))`;
				yield* sql`CREATE TABLE topic_idempotency(instance TEXT,key TEXT,input TEXT,outcome TEXT,PRIMARY KEY(instance,key))`;
				yield* sql`CREATE TABLE read_idempotency(instance TEXT,key TEXT,topic TEXT,requested_seq INTEGER,effective_seq INTEGER)`;
				yield* sql`CREATE TABLE reaction_idempotency(instance TEXT,key TEXT,message TEXT,emoji TEXT,outcome TEXT)`;
				yield* sql.withTransaction(migrateIdempotency(sql));
				yield* sql`CREATE TABLE domain(value TEXT)`;
				const relay = makeOutboxRelay(sql, boot);
				const mutate = makeMutate(sql, crypto, boot, relay, yield* Semaphore.make(1));
				const receipt = {
					instance: "instance",
					key: "key",
					kind: "test.changed",
					input: "same",
					outcome: Schema.fromJsonString(Schema.String),
				};
				const event = (seq: number): typeof EventRecord.Type => ({
					seq,
					at: now,
					type: "test.changed",
					level: "info",
					actor: "test",
					instance: "instance",
					generation: 1,
					request_id: null,
					topic: null,
					message_id: null,
					payload: {},
				});
				const run = (value: string, operational = false) =>
					mutate({
						idempotency: { ...receipt, ...(operational ? { scope: "operational" as const } : {}) },
						body: () =>
							Effect.gen(function* () {
								yield* sql`INSERT INTO domain VALUES(${value})`;
								return { outcome: value, events: [] };
							}),
					});
				if (mode === "expiry" || mode === "operational" || mode === "backup") {
					const operational = mode === "operational";
					assert.equal(yield* run("original", operational), "original");
					const rows = yield* sql`SELECT expires_at FROM idempotency`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ expires_at: Schema.Int })))),
					);
					assert.equal(rows[0]?.expires_at, now + 30 * day);
					const deadline = now + 30 * day;
					if (mode === "backup") yield* sql`VACUUM INTO ${`${root}/backup.db`}`;
					now = deadline - 1;
					assert.equal(yield* run("changed", operational), "original");
					const conflict = yield* mutate({
						idempotency: { ...receipt, kind: "different", ...(operational ? { scope: "operational" as const } : {}) },
						body: () => Effect.die("conflicting receipt executed"),
					}).pipe(Effect.result);
					assert.equal(conflict._tag, "Failure");
					now = deadline;
					if (mode === "backup")
						yield* Effect.gen(function* () {
							const restored = yield* SqlClient.SqlClient;
							yield* makeOutboxRelay(restored, boot);
							assert.ok(Option.isNone(yield* lookupIdempotency(restored, crypto, receipt)));
						}).pipe(
							Effect.provide(SqliteClient.layer({ filename: `${root}/backup.db`, disableWAL: true })),
							Effect.scoped,
						);
					assert.equal(yield* run("after window", operational), "after window");
					assert.deepEqual(yield* sql`SELECT value FROM domain`, [{ value: "original" }, { value: "after window" }]);
				} else if (mode === "pending" || mode === "incomplete" || mode === "restore-outbox") {
					blocked = true;
					const result = yield* mutate({
						idempotency: receipt,
						body: (reserve) =>
							Effect.gen(function* () {
								const range = yield* reserve(2);
								return { outcome: "pending", events: [event(range.from), event(range.to)] };
							}),
					}).pipe(Effect.result);
					assert.equal(result._tag, "Failure");
					if (mode === "restore-outbox") {
						yield* sql`VACUUM INTO ${`${root}/old-outbox.db`}`;
						blocked = false;
						yield* relay;
						yield* bootSql`DELETE FROM events`;
						yield* Effect.gen(function* () {
							const restored = yield* SqlClient.SqlClient;
							yield* makeOutboxRelay(restored, boot);
							assert.equal((yield* restored`SELECT * FROM outbox`).length, 0);
							assert.equal((yield* restored`SELECT * FROM mutation_batches`).length, 1);
							assert.equal(Option.getOrThrow(yield* lookupIdempotency(restored, crypto, receipt)), "pending");
						}).pipe(
							Effect.provide(SqliteClient.layer({ filename: `${root}/old-outbox.db`, disableWAL: true })),
							Effect.scoped,
						);
						assert.equal((yield* events.query({ since: 0, limit: 10 })).items.length, 0);
						assert.equal((yield* bootSql`SELECT * FROM event_batches`).length, 1);
						return yield* Console.log(`RETENTION_${mode}_OK`);
					}
					now += 31 * day;
					if (mode === "incomplete") {
						yield* sql`DELETE FROM outbox WHERE seq=2`;
						blocked = false;
					}
					assert.equal((yield* relay.pipe(Effect.result))._tag, "Failure");
					assert.equal((yield* sql`SELECT * FROM idempotency`).length, 1);
					assert.equal((yield* sql`SELECT * FROM mutation_batches`).length, 1);
					assert.equal((yield* events.state).published_through, 0);
					if (mode === "pending") {
						blocked = false;
						yield* relay;
						assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
						assert.equal((yield* sql`SELECT * FROM idempotency`).length, 0);
						assert.equal((yield* events.state).published_through, 2);
					}
				} else if (mode === "bounded") {
					yield* sql`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<300)
					INSERT INTO idempotency SELECT 'instance',n,'test','hash','"old"',0 FROM ids`;
					yield* relay;
					assert.equal((yield* sql`SELECT * FROM idempotency`).length, 44);
					yield* relay;
					assert.equal((yield* sql`SELECT * FROM idempotency`).length, 0);
				} else if (mode === "legacy-shipped") {
					for (let index = 0; index < 17; index++) {
						const id = `legacy-${index}`;
						const range = yield* boot.reserve(id, 1);
						const item = event(range.from);
						yield* boot.append({ ...range, events: [item] });
						yield* sql`INSERT INTO mutation_batches VALUES(${id},${range.from},${range.to},1)`;
						yield* sql`INSERT INTO outbox VALUES(${item.seq},${id},${JSON.stringify(item)},1)`;
					}
					yield* sql`INSERT INTO idempotency VALUES('instance','key','test','hash','"old"',0)`;
					yield* relay;
					assert.equal((yield* sql`SELECT * FROM outbox`).length, 1);
					assert.equal((yield* sql`SELECT * FROM idempotency`).length, 1);
					yield* relay;
					assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
					assert.equal((yield* sql`SELECT * FROM mutation_batches`).length, 17);
					assert.equal((yield* events.query({ since: 0, limit: 20 })).items.length, 17);
					assert.equal((yield* sql`SELECT * FROM idempotency`).length, 0);
				}
				yield* Console.log(`RETENTION_${mode}_OK`);
			}).pipe(Effect.provide(SqliteClient.layer({ filename: boot.filename, disableWAL: true })), Effect.scoped);
		}).pipe(Effect.provide(eventsLayer(Effect.void)));
	}).pipe(
		Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })),
		Effect.scoped,
		Effect.provideService(Clock.Clock, {
			currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
			currentTimeNanos: clock.currentTimeNanos,
			monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
			monotonicTimeNanos: clock.monotonicTimeNanos,
			sleep: (duration) => clock.sleep(duration),
			currentTimeMillis: Effect.sync(() => now),
			currentTimeMillisUnsafe: () => now,
		}),
	);
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
BunRuntime.runMain(program);
