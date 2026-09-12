import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Cause, Console, Crypto, Effect, Exit, Layer, Schema, Semaphore } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient, Statement } from "effect/unstable/sql";
import { Reactivity } from "effect/unstable/reactivity";
import type { EventRecord } from "@comms/protocol/events";
import { BootChannel, KernelError, layer as bootLayer } from "../../src/kernel/boot-channel.ts";
import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { probeHealth } from "../../src/kernel/health.ts";
import { layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";
import { makeMutate } from "../../src/kernel/mutate.ts";

const program = Effect.gen(function* () {
	const [filename, mode] = process.argv.slice(2);
	if (!filename || !["confirmed", "uncertain"].includes(mode ?? "")) return yield* Effect.die("Invalid arguments");
	yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const realBoot = yield* BootChannel;
		yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT NOT NULL)`;
		yield* sql`INSERT INTO kernel_writer VALUES(1,${realBoot.epoch})`;
		yield* sql`CREATE TABLE mutation_batches(id TEXT PRIMARY KEY,from_seq INTEGER,to_seq INTEGER,count INTEGER)`;
		yield* sql`CREATE TABLE outbox(seq INTEGER PRIMARY KEY,transaction_id TEXT,event TEXT,shipped_at INTEGER)`;
		yield* sql`CREATE TABLE domain(value TEXT)`;
		const empty = Effect.gen(function* () {
			assert.equal((yield* sql`SELECT * FROM domain`).length, 0);
			assert.equal((yield* sql`SELECT * FROM mutation_batches`).length, 0);
			assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
		});
		const ranges: Array<{ transaction: string; from: number; to: number }> = [];
		const aborts: string[] = [];
		let appends = 0;
		let relays = 0;
		const boot: BootChannel["Service"] = {
			...realBoot,
			reserve: (transaction, count) =>
				realBoot.reserve(transaction, count).pipe(
					Effect.tap((range) =>
						Effect.sync(() => {
							ranges.push(range);
						}),
					),
				),
			abort: (transaction) =>
				Effect.gen(function* () {
					// This runs inside the protocol, before forwarding each abort, not merely after probe completion.
					yield* empty.pipe(Effect.orDie);
					aborts.push(transaction);
					yield* realBoot.abort(transaction);
				}),
			append: (batch) =>
				Effect.sync(() => {
					appends++;
				}).pipe(Effect.andThen(realBoot.append(batch))),
		};
		const probeSql =
			mode === "uncertain"
				? yield* SqlClient.make({
						acquirer: sql.reserve,
						transactionAcquirer: sql.reserve,
						compiler: Statement.makeCompilerSqlite(),
						transactionService: sql.transactionService,
						spanAttributes: [],
						rollback: "INVALID ROLLBACK",
					}).pipe(Effect.provide(Reactivity.layer))
				: sql;
		const mutate = makeMutate(
			probeSql,
			yield* Crypto.Crypto,
			boot,
			Effect.sync(() => {
				relays++;
			}),
			yield* Semaphore.make(1),
		);
		const event = (seq: number): typeof EventRecord.Type => ({
			seq,
			at: 1,
			type: "rehearsal.test",
			level: "info",
			actor: "test",
			instance: "fixture",
			generation: realBoot.generation,
			request_id: null,
			topic: null,
			message_id: null,
			payload: {},
		});
		const before = Effect.gen(function* () {
			for (const value of ["first", "second"])
				yield* mutate({
					body: (reserve) =>
						Effect.gen(function* () {
							const range = yield* reserve(2);
							yield* probeSql`INSERT INTO domain VALUES(${value})`;
							return { outcome: value, events: [event(range.from), event(range.to)] };
						}),
				});
			assert.deepEqual(yield* probeSql`SELECT value FROM domain ORDER BY rowid`, [
				{ value: "first" },
				{ value: "second" },
			]);
		});
		const result = yield* probeHealth(
			before.pipe(Effect.andThen(new KernelError({ code: "health_read_invalid" }))),
			true,
		).pipe(
			Effect.provide(publicationLayer),
			Effect.provide(lifecycleLayer),
			Effect.provideService(SqlClient.SqlClient, probeSql),
			Effect.provideService(BootChannel, boot),
			Effect.exit,
		);
		assert.ok(Exit.isFailure(result));
		assert.equal(appends, 0);
		assert.equal(relays, 0);
		assert.deepEqual(
			ranges.slice(0, 2).map(({ from, to }) => ({ from, to })),
			[
				{ from: 101, to: 102 },
				{ from: 103, to: 104 },
			],
		);
		assert.notEqual(ranges[0]?.transaction, ranges[1]?.transaction);
		if (mode === "uncertain") {
			assert.ok(Cause.hasDies(result.cause));
			assert.equal(aborts.length, 0);
			assert.equal(ranges.length, 2);
			assert.equal((yield* sql`SELECT * FROM domain`).length, 2);
			assert.equal((yield* sql`SELECT * FROM mutation_batches`).length, 2);
			assert.equal((yield* sql`SELECT * FROM outbox`).length, 4);
			// Both reservation receipts still exist; changed counts conflict rather than allocating again.
			for (const range of ranges) {
				const retry = yield* realBoot.reserve(range.transaction, 3).pipe(Effect.result);
				assert.equal(retry._tag, "Failure");
			}
			yield* sql`ROLLBACK`;
			yield* empty;
		} else {
			assert.equal(Cause.hasDies(result.cause), false);
			assert.ok(
				result.cause.reasons.every(
					(reason) =>
						Cause.isFailReason(reason) &&
						Schema.is(KernelError)(reason.error) &&
						reason.error.code === "health_read_invalid",
				),
			);
			yield* empty;
			assert.equal(ranges.length, 4);
			assert.deepEqual(ranges.slice(2), ranges.slice(0, 2));
			assert.deepEqual(
				aborts,
				ranges.slice(0, 2).map(({ transaction }) => transaction),
			);
			for (const transaction of aborts)
				assert.equal((yield* realBoot.abort(transaction).pipe(Effect.result))._tag, "Failure");
		}
		yield* Console.log("REHEARSAL_ROLLBACK_VERIFIED");
	}).pipe(
		Effect.provide(SqliteClient.layer({ filename, disableWAL: true })),
		Effect.provide(bootLayer.pipe(Layer.provide(FetchHttpClient.layer))),
	);
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
