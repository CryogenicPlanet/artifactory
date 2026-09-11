import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Cause, Console, Deferred, Effect, Fiber, Layer, Ref, Schema, Semaphore } from "effect";
import { TestClock } from "effect/testing";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, Statement } from "effect/unstable/sql";
import { KernelError } from "../../src/kernel/boot-channel.ts";
import { makeReadSnapshot } from "../../src/kernel/read-snapshot.ts";
import { Lifecycle, assertWriterHealthy, layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";

const program = Effect.gen(function* () {
	const mode = process.argv[2];
	const sql = yield* SqlClient.SqlClient;
	const lifecycle = yield* Lifecycle;
	yield* Ref.set(lifecycle.state, "live");
	yield* Ref.set(lifecycle.healthy, true);
	yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY, epoch TEXT)`;
	yield* sql`INSERT INTO kernel_writer VALUES(1,'owner')`;
	yield* sql`CREATE TABLE outbox(seq INTEGER, event TEXT, shipped_at INTEGER)`;
	yield* sql`CREATE TABLE changes(value TEXT)`;
	const mutex = yield* Semaphore.make(1);
	const client =
		mode === "rollback-defect"
			? yield* SqlClient.make({
					acquirer: sql.reserve,
					transactionAcquirer: sql.reserve,
					transactionService: sql.transactionService,
					compiler: Statement.makeCompilerSqlite(),
					spanAttributes: [],
					rollback: "INVALID ROLLBACK",
				}).pipe(Effect.provide(Reactivity.layer))
			: sql;
	const read = makeReadSnapshot(
		client,
		"owner",
		mutex,
		Effect.succeed({ published_through: 0 }),
		Effect.void,
		yield* Effect.scope,
	);
	const entered = yield* Deferred.make<void>();
	const cleanupRelease = yield* Deferred.make<void>();
	if (mode === "cleanup-overrun" || mode === "cancel-overrun") {
		const pending = yield* read(() =>
			Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Deferred.await(cleanupRelease)),
			),
		).pipe(Effect.forkChild);
		yield* Deferred.await(entered);
		if (mode === "cancel-overrun") yield* Fiber.interrupt(pending).pipe(Effect.forkChild);
		yield* TestClock.adjust("4 seconds");
		assert.equal(yield* Ref.get(lifecycle.healthy), false);
		assert.equal(pending.pollUnsafe(), undefined);
		const nextOwner = yield* mutex.withPermit(Ref.get(lifecycle.healthy)).pipe(Effect.forkChild);
		yield* Effect.yieldNow;
		assert.equal(nextOwner.pollUnsafe(), undefined);
		yield* Deferred.succeed(cleanupRelease, undefined);
		assert.equal((yield* Fiber.await(pending))._tag, "Failure");
		assert.equal(yield* Fiber.join(nextOwner), false);
		assert.equal((yield* assertWriterHealthy.pipe(Effect.result))._tag, "Failure");
		yield* Console.log("READ_DEADLINE_VERIFIED");
		return;
	}
	if (mode === "queued" || mode === "queued-outer-mask") {
		yield* mutex.take(1);
		const pending = yield* read(() => Effect.die("Queued callback must not run")).pipe(
			mode === "queued-outer-mask" ? Effect.uninterruptible : (effect) => effect,
			Effect.exit,
			Effect.forkChild,
		);
		yield* TestClock.adjust("3 seconds");
		const result = yield* Fiber.join(pending);
		assert.equal(result._tag, "Failure");
		if (result._tag === "Failure")
			assert.equal(
				result.cause.reasons.some(
					(reason) =>
						Cause.isFailReason(reason) &&
						Schema.is(KernelError)(reason.error) &&
						reason.error.code === "read_snapshot_timeout",
				),
				true,
			);
		assert.deepEqual(yield* sql`SELECT * FROM changes`, []);
		yield* mutex.release(1);
		assert.equal(yield* read(() => Effect.succeed("available")), "available");
	} else {
		const pending = yield* read(() =>
			Effect.gen(function* () {
				yield* client`INSERT INTO changes VALUES('must roll back')`;
				yield* Deferred.succeed(entered, undefined);
				if (mode === "nested") {
					yield* Effect.sleep("2 seconds");
					return yield* read(() => Effect.sleep("2 seconds"));
				}
				return yield* mode === "cleanup-wait"
					? Effect.never.pipe(Effect.ensuring(Deferred.await(cleanupRelease)))
					: Effect.never;
			}),
		).pipe(Effect.exit, Effect.forkChild);
		yield* Deferred.await(entered);
		yield* TestClock.adjust("3 seconds");
		if (mode === "cleanup-wait") {
			yield* TestClock.adjust("500 millis");
			assert.equal(yield* Ref.get(lifecycle.healthy), true);
			assert.equal(pending.pollUnsafe(), undefined);
			const nextOwner = yield* mutex.withPermit(Effect.void).pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			assert.equal(nextOwner.pollUnsafe(), undefined);
			yield* Deferred.succeed(cleanupRelease, undefined);
			yield* Fiber.join(nextOwner);
		}
		const result = yield* Fiber.join(pending);
		assert.equal(result._tag, "Failure");
		if (result._tag === "Failure") {
			assert.equal(Cause.hasDies(result.cause), mode === "rollback-defect");
			assert.equal(
				result.cause.reasons.some(
					(reason) =>
						Cause.isFailReason(reason) &&
						Schema.is(KernelError)(reason.error) &&
						reason.error.code === "read_snapshot_timeout",
				),
				mode !== "rollback-defect",
			);
		}
		assert.equal(yield* Ref.get(lifecycle.healthy), mode !== "rollback-defect");
		const write = assertWriterHealthy.pipe(
			Effect.andThen(sql.withTransaction(sql`INSERT INTO changes VALUES('next writer')`)),
		);
		const next = yield* write.pipe(Effect.exit);
		if (mode === "rollback-defect") {
			assert.equal(next._tag, "Failure");
			if (next._tag === "Failure")
				assert.equal(
					next.cause.reasons.some(
						(reason) =>
							Cause.isFailReason(reason) &&
							Schema.is(KernelError)(reason.error) &&
							reason.error.code === "boot_unavailable",
					),
					true,
				);
			// Actual invalid rollback left its transaction open; no following writer touched it.
			assert.deepEqual(yield* sql`SELECT * FROM changes`, [{ value: "must roll back" }]);
			yield* sql`ROLLBACK`;
		} else {
			assert.equal(next._tag, "Success");
			assert.deepEqual(yield* sql`SELECT * FROM changes`, [{ value: "next writer" }]);
			assert.equal(yield* read(() => Effect.succeed("available")), "available");
		}
	}
	yield* TestClock.adjust("2 seconds");
	assert.equal(yield* Ref.get(lifecycle.healthy), mode !== "rollback-defect");
	yield* Console.log("READ_DEADLINE_VERIFIED");
}).pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), lifecycleLayer, TestClock.layer(), BunServices.layer),
	),
);
program.pipe(BunRuntime.runMain);
