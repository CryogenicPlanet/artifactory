import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { memoryStoreLayer } from "./test-store.ts";
import { Clock, Console, Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { Publication, layer as publicationLayer } from "../../src/kernel/publication.ts";

const program = Effect.gen(function* () {
	const mode = process.argv[2];
	const sql = yield* SqlClient.SqlClient;
	const blocked = yield* Ref.make(false);
	const published = yield* Ref.make(0);
	const allocated = yield* Ref.make(0);
	const passes = yield* Ref.make<ReadonlyArray<number>>([]);
	const countPass = Clock.currentTimeMillis.pipe(Effect.flatMap((at) => Ref.update(passes, (items) => [...items, at])));
	const boot: BootChannel["Service"] & { readonly filename: string } = {
		epoch: "writer",
		store: { _tag: "file", filename: ":memory:" },
		filename: ":memory:",
		generation: 1,
		backup: Effect.void,
		changed: () => Effect.die("Relay must not wait for the publication fence"),
		fence: Ref.get(published).pipe(Effect.map((published_through) => ({ published_through }))),
		events: (input) => Effect.succeed({ items: [], cursor: input.since ?? 0, timed_out: false, drained: false }),
		reserve: (transaction, count) =>
			Ref.getAndUpdate(allocated, (next) => next + count).pipe(
				Effect.map((before) => ({ transaction, from: before + 1, to: before + count })),
			),
		abort: () => Effect.void,
		append: (batch) =>
			Effect.gen(function* () {
				if (yield* Ref.get(blocked)) return yield* new KernelError({ code: "boot_unavailable" });
				yield* Ref.set(published, batch.to);
				return { published_through: batch.to };
			}),
	};
	yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT NOT NULL)`;
	yield* sql`INSERT INTO kernel_writer VALUES(1,'writer')`;
	yield* sql`CREATE TABLE mutation_batches(id TEXT PRIMARY KEY,from_seq INTEGER,to_seq INTEGER,count INTEGER)`;
	yield* sql`CREATE TABLE outbox(seq INTEGER PRIMARY KEY,transaction_id TEXT,event TEXT,shipped_at INTEGER)`;
	yield* sql`CREATE TABLE idempotency(instance TEXT,key TEXT,kind TEXT,input_hash TEXT,outcome TEXT,expires_at INTEGER,PRIMARY KEY(instance,key))`;
	yield* sql`CREATE TABLE domain(value TEXT)`;
	yield* Effect.gen(function* () {
		const publication = yield* Publication;
		if (mode === "idle") {
			const fiber = yield* publication
				.runRelay(countPass.pipe(Effect.andThen(publication.relay)))
				.pipe(Effect.forkScoped);
			yield* TestClock.adjust(0);
			assert.deepEqual(yield* Ref.get(passes), [0]);
			yield* TestClock.adjust("29 seconds");
			assert.deepEqual(yield* Ref.get(passes), [0]);
			yield* sql`INSERT INTO idempotency VALUES('instance','key','test','hash','"old"',30000)`;
			yield* TestClock.adjust("1 second");
			assert.deepEqual(yield* Ref.get(passes), [0, 30000, 30000]);
			assert.equal((yield* sql`SELECT * FROM idempotency`).length, 0);
			yield* Fiber.interrupt(fiber);
			const stopped = yield* Ref.get(passes);
			yield* TestClock.adjust("1 minute");
			assert.deepEqual(yield* Ref.get(passes), stopped);
		} else if (mode === "coalesced") {
			const held = yield* Deferred.make<void>();
			const fiber = yield* publication
				.runRelay(countPass.pipe(Effect.andThen(Deferred.await(held))))
				.pipe(Effect.forkScoped);
			yield* TestClock.adjust(0);
			for (let index = 0; index < 100; index++) yield* publication.wake;
			yield* Deferred.succeed(held, undefined);
			yield* TestClock.adjust(0);
			assert.deepEqual(yield* Ref.get(passes), [0, 0]);
			yield* Fiber.interrupt(fiber);
		} else if (mode === "retry") {
			const fiber = yield* publication
				.runRelay(countPass.pipe(Effect.andThen(Effect.fail("unavailable"))))
				.pipe(Effect.forkScoped);
			yield* TestClock.adjust(7100);
			assert.deepEqual(yield* Ref.get(passes), [0, 100, 300, 700, 1500, 3100, 5100, 7100]);
			yield* Fiber.interrupt(fiber);
		} else if (mode === "mutation") {
			const fiber = yield* publication
				.runRelay(countPass.pipe(Effect.andThen(publication.relay)))
				.pipe(Effect.forkScoped);
			yield* TestClock.adjust(0);
			yield* Ref.set(blocked, true);
			const result = yield* publication
				.mutate({
					body: (reserve) =>
						Effect.gen(function* () {
							const range = yield* reserve(1);
							yield* sql`INSERT INTO domain VALUES('committed')`;
							return {
								outcome: "committed",
								events: [
									{
										seq: range.from,
										at: 0,
										type: "test.changed",
										level: "info" as const,
										actor: "test",
										instance: "instance",
										generation: 1,
										request_id: null,
										topic: null,
										message_id: null,
										payload: {},
									},
								],
							};
						}),
				})
				.pipe(Effect.result);
			assert.equal(result._tag, "Failure");
			yield* TestClock.adjust(0);
			assert.deepEqual(yield* Ref.get(passes), [0, 0]);
			assert.deepEqual(yield* sql`SELECT * FROM domain`, [{ value: "committed" }]);
			assert.equal((yield* sql`SELECT * FROM outbox`).length, 1);
			assert.equal(yield* Ref.get(published), 0);
			yield* Ref.set(blocked, false);
			yield* TestClock.adjust(99);
			assert.equal((yield* sql`SELECT * FROM outbox`).length, 1);
			yield* TestClock.adjust(1);
			assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
			assert.equal(yield* Ref.get(published), 1);
			assert.deepEqual(yield* sql`SELECT * FROM domain`, [{ value: "committed" }]);
			yield* Fiber.interrupt(fiber);
		} else if (mode === "backlog") {
			for (let index = 1; index <= 33; index++) {
				const event = JSON.stringify({
					seq: index,
					at: 0,
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
				yield* sql`INSERT INTO mutation_batches VALUES(${String(index)},${index},${index},1)`;
				yield* sql`INSERT INTO outbox VALUES(${index},${String(index)},${event},1)`;
			}
			yield* sql`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<600)
				INSERT INTO idempotency SELECT 'instance',n,'test','hash','"old"',0 FROM ids`;
			const sizes = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([]);
			const drained = yield* Deferred.make<void>();
			const fiber = yield* publication
				.runRelay(
					Effect.gen(function* () {
						yield* publication.relay;
						const outbox = (yield* sql`SELECT * FROM outbox`).length;
						const receipts = (yield* sql`SELECT * FROM idempotency`).length;
						yield* Ref.update(sizes, (items) => [...items, [outbox, receipts]]);
						if (outbox === 0 && receipts === 0) yield* Deferred.succeed(drained, undefined);
					}),
				)
				.pipe(Effect.forkScoped);
			yield* TestClock.adjust(0);
			yield* Deferred.await(drained);
			assert.deepEqual((yield* Ref.get(sizes)).slice(0, 5), [
				[17, 600],
				[1, 600],
				[0, 344],
				[0, 88],
				[0, 0],
			]);
			assert.equal((yield* sql`SELECT * FROM mutation_batches`).length, 33);
			yield* Fiber.interrupt(fiber);
		} else return yield* Effect.die(`Unknown fixture mode ${mode}`);
	}).pipe(Effect.provide(publicationLayer), Effect.provideService(BootChannel, boot));
	yield* Console.log(`PUBLICATION_RELAY_${mode}_OK`);
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, memoryStoreLayer(), TestClock.layer())));
BunRuntime.runMain(program);
