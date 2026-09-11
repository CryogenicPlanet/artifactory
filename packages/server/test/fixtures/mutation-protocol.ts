import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Cause, Console, Crypto, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Semaphore } from "effect";
import { SqlClient, Statement } from "effect/unstable/sql";
import { Reactivity } from "effect/unstable/reactivity";
import { Events, eventsSchema, layer as eventsLayer } from "../../../boot/src/events.ts";
import { type EventRecord } from "@comms/protocol/events";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { makeOutboxRelay } from "../../src/kernel/outbox.ts";
import { HealthProbe, layer as probeLayer } from "../../src/kernel/health-probe.ts";
import { HttpServerResponse } from "effect/unstable/http";
import { probeHealth } from "../../src/kernel/health.ts";
import { Messages, layer as messagesLayer } from "../../src/ext/core/messages.ts";
import { Lifecycle, layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";
import { makeMutate } from "../../src/kernel/mutate.ts";

const program = Effect.gen(function* () {
	const [root, mode] = process.argv.slice(2);
	if (!root || !mode) return yield* Effect.die("Missing fixture arguments");
	yield* Effect.gen(function* () {
		if (mode !== "restart-after-ack") {
			yield* eventsSchema;
			yield* (yield* SqlClient.SqlClient)`ALTER TABLE events ADD COLUMN topic TEXT`;
		}
		yield* Effect.gen(function* () {
			const events = yield* Events;
			const epoch = "current-writer";
			const reservations: Array<{ transaction: string; count: number }> = [];
			const aborts: string[] = [];
			let appendFailed = false;
			let appends = 0;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });
			const boot: BootChannel["Service"] = {
				epoch,
				filename: `${root}/app.db`,
				generation: 1,
				backup: Effect.void,
				changed: (after) => events.changed(after).pipe(Effect.mapError(unavailable)),
				fence: events.state.pipe(
					Effect.map(({ published_through }) => ({ published_through })),
					Effect.mapError(unavailable),
				),
				events: (input) => events.query(input).pipe(Effect.mapError(unavailable)),
				reserve: (transaction, count) =>
					Effect.gen(function* () {
						reservations.push({ transaction, count });
						const range = yield* events.reserve(transaction, count, epoch).pipe(Effect.mapError(unavailable));
						if ((mode === "reserve-lost" || mode === "caught-reserve") && reservations.length === 1)
							return yield* unavailable();
						return range;
					}),
				abort: (transaction) =>
					Effect.gen(function* () {
						aborts.push(transaction);
						yield* events.abort(transaction, epoch).pipe(Effect.mapError(unavailable));
					}),
				append: (batch) =>
					Effect.gen(function* () {
						appends++;
						const result = yield* events.append(batch, epoch).pipe(Effect.mapError(unavailable));
						if (mode === "crash-after-ack") process.exit(72);
						if (mode === "append-lost" && !appendFailed) {
							appendFailed = true;
							return yield* unavailable();
						}
						return result;
					}),
			};
			yield* Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const lifecycle = yield* Lifecycle;
				yield* Ref.set(lifecycle.state, "live");
				yield* Ref.set(lifecycle.healthy, true);
				if (mode !== "restart-after-ack") {
					yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT NOT NULL)`;
					yield* sql`INSERT INTO kernel_writer VALUES(1,${epoch})`;
					yield* sql`CREATE TABLE mutation_batches(id TEXT PRIMARY KEY,from_seq INTEGER,to_seq INTEGER,count INTEGER)`;
					yield* sql`CREATE TABLE outbox(seq INTEGER PRIMARY KEY,transaction_id TEXT,event TEXT,shipped_at INTEGER)`;
					yield* sql`CREATE TABLE idempotency(instance TEXT,key TEXT,kind TEXT,input_hash TEXT,outcome TEXT,expires_at INTEGER NOT NULL,PRIMARY KEY(instance,key))`;
					yield* sql`CREATE TABLE domain(value TEXT)`;
				}

				const crypto = yield* Crypto.Crypto;
				const mutex = yield* Semaphore.make(1);
				let relays = 0;
				const relay = Effect.sync(() => {
					relays++;
				}).pipe(Effect.andThen(makeOutboxRelay(sql, boot)));
				// Exercise the real Effect transaction finalizer with a failing driver control statement.
				const mutationSql =
					mode.endsWith("commit-defect") || mode.endsWith("rollback-defect")
						? yield* SqlClient.make({
								acquirer: sql.reserve,
								transactionAcquirer: sql.reserve,
								compiler: Statement.makeCompilerSqlite(),
								transactionService: sql.transactionService,
								spanAttributes: [],
								...(mode.endsWith("commit-defect") ? { commit: "INVALID COMMIT" } : { rollback: "INVALID ROLLBACK" }),
							}).pipe(Effect.provide(Reactivity.layer))
						: sql;
				const mutate = makeMutate(
					mode === "relay-commit-defect" ? sql : mutationSql,
					crypto,
					boot,
					mode === "relay-commit-defect" ? makeOutboxRelay(mutationSql, boot) : relay,
					mutex,
				);
				const event = (seq: number): typeof EventRecord.Type => ({
					seq,
					at: 1,
					type: "test.changed",
					level: "info",
					actor: "test",
					instance: "instance",
					generation: 1,
					request_id: "request",
					topic: null,
					message_id: null,
					payload: {},
				});
				const receipt = {
					instance: "instance",
					key: "key",
					kind: "test.changed",
					input: "stable-input",
					outcome: Schema.fromJsonString(Schema.String),
				};
				const records = () => sql`SELECT value FROM domain`;
				const assertEmpty = Effect.gen(function* () {
					assert.equal((yield* records()).length, 0);
					assert.equal((yield* sql`SELECT * FROM mutation_batches`).length, 0);
					assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
					assert.equal((yield* sql`SELECT * FROM idempotency`).length, 0);
				});
				if (mode === "poisoned-commit-defect") {
					yield* Effect.gen(function* () {
						const messages = yield* Messages;
						const entered = yield* Deferred.make<void>();
						const release = yield* Deferred.make<void>();
						const first = yield* messages
							.mutate({
								body: (reserve) =>
									Effect.gen(function* () {
										const range = yield* reserve(1);
										yield* sql`INSERT INTO domain VALUES('uncommitted')`;
										yield* Deferred.succeed(entered, undefined);
										yield* Deferred.await(release);
										return { outcome: "uncommitted", events: [event(range.from)] };
									}),
							})
							.pipe(Effect.exit, Effect.forkScoped);
						yield* Deferred.await(entered);
						// All three calls enter while healthy and queue behind the active transaction.
						// Their health check must run after acquiring the same writer permit.
						const queued = [];
						for (const operation of [
							messages.change(Effect.die("queued mutation must not execute")).pipe(Effect.asVoid),
							messages.relay,
							messages
								.moveTopic(
									{ agent: "test", instance: "instance", request: "move", kind: "human" },
									"source",
									"destination",
									{
										prepare: () => Effect.die("queued move must not prepare pages"),
										finish: () => Effect.die("queued move must not finish pages"),
									},
								)
								.pipe(Effect.asVoid),
						])
							queued.push(yield* operation.pipe(Effect.exit, Effect.forkScoped({ startImmediately: true })));
						yield* Deferred.succeed(release, undefined);
						const failed = yield* Fiber.join(first);
						assert.ok(Exit.isFailure(failed));
						assert.ok(Cause.hasDies(failed.cause));
						assert.equal(yield* Ref.get(lifecycle.healthy), false);
						for (const fiber of queued) {
							const result = yield* Fiber.join(fiber);
							assert.ok(Exit.isFailure(result));
							assert.equal(result.cause.reasons.length, 1);
							const reason = result.cause.reasons[0];
							assert.ok(reason && Cause.isFailReason(reason));
							assert.ok(Schema.is(KernelError)(reason.error));
							assert.equal(reason.error.code, "boot_unavailable");
						}
						assert.equal(appends, 0);
						assert.equal(aborts.length, 0);
						assert.equal(reservations.length, 1);
						const pending = yield* events.state;
						assert.equal(pending.pending_id, reservations[0]?.transaction);
						assert.equal(pending.published_through, 0);
						// The failed finalizer really left uncommitted data on this connection.
						assert.deepEqual(yield* records(), [{ value: "uncommitted" }]);
						assert.equal((yield* sql`SELECT * FROM outbox`).length, 1);
						yield* sql`ROLLBACK`;
						yield* assertEmpty;
						assert.deepEqual(yield* events.state, pending);
					}).pipe(
						Effect.provide(messagesLayer.pipe(Layer.provideMerge(publicationLayer))),
						Effect.provideService(SqlClient.SqlClient, mutationSql),
						Effect.provideService(BootChannel, boot),
					);
				} else if (mode === "receipt") {
					const run = (value: string) =>
						mutate({
							idempotency: receipt,
							body: () =>
								Effect.gen(function* () {
									yield* sql`INSERT INTO domain VALUES(${value})`;
									return { outcome: value, events: [] };
								}),
						});
					assert.equal(yield* run("original"), "original");
					assert.equal(yield* run("changed"), "original");
					assert.deepEqual(yield* records(), [{ value: "original" }]);
					assert.equal((yield* sql`SELECT * FROM idempotency`).length, 1);
					assert.equal((yield* sql`SELECT * FROM mutation_batches`).length, 0);
					assert.equal(reservations.length, 0);
					const conflict = yield* mutate({
						idempotency: { ...receipt, kind: "different", outcome: Schema.fromJsonString(Schema.Int) },
						body: () => Effect.die("must not replay incompatible kind"),
					}).pipe(Effect.result);
					assert.equal(conflict._tag, "Failure");
					if (conflict._tag === "Failure")
						assert.equal(Schema.is(KernelError)(conflict.failure) && conflict.failure.code, "idempotency_conflict");
				} else if (
					mode === "variable-batch" ||
					mode === "relay-commit-defect" ||
					mode === "append-lost" ||
					mode === "crash-after-ack" ||
					mode === "restart-after-ack" ||
					mode === "cleanup-failed"
				) {
					const run = (value: string) =>
						mutate({
							idempotency: receipt,
							body: (reserve) =>
								Effect.gen(function* () {
									const range = yield* reserve(3);
									yield* sql`INSERT INTO domain VALUES(${value})`;
									return { outcome: value, events: [event(range.from), event(range.from + 1), event(range.to)] };
								}),
						});
					if (mode === "relay-commit-defect") {
						const failed = yield* run("original").pipe(Effect.exit);
						assert.ok(Exit.isFailure(failed));
						assert.ok(Cause.hasDies(failed.cause));
						assert.equal(yield* Ref.get(lifecycle.healthy), false);
						assert.equal(appends, 1);
						assert.equal(aborts.length, 0);
						assert.equal(reservations.length, 1);
						assert.equal((yield* events.state).published_through, 3);
						// Failed cleanup COMMIT left an open transaction hiding the committed outbox.
						assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
						yield* Effect.gen(function* () {
							const messages = yield* Messages;
							for (const next of [messages.relay, messages.change(Effect.die("must not mutate"))]) {
								const denied = yield* next.pipe(Effect.result);
								assert.equal(denied._tag, "Failure");
								if (denied._tag === "Failure")
									assert.equal(Schema.is(KernelError)(denied.failure) && denied.failure.code, "boot_unavailable");
							}
						}).pipe(
							Effect.provide(messagesLayer.pipe(Layer.provideMerge(publicationLayer))),
							Effect.provideService(BootChannel, boot),
						);
						assert.equal(appends, 1);
						yield* sql`ROLLBACK`;
						assert.deepEqual(yield* records(), [{ value: "original" }]);
						assert.equal((yield* sql`SELECT * FROM outbox`).length, 3);
						return yield* Console.log("MUTATION_VERIFIED");
					}
					if (mode === "cleanup-failed")
						yield* sql`CREATE TRIGGER fail_cleanup BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT,'cleanup unavailable'); END`;
					if (mode === "append-lost" || mode === "cleanup-failed") {
						assert.equal((yield* run("original").pipe(Effect.result))._tag, "Failure");
						assert.equal((yield* sql`SELECT * FROM idempotency`).length, 1);
						assert.equal((yield* sql`SELECT * FROM outbox WHERE shipped_at IS NULL`).length, 3);
						assert.deepEqual(yield* records(), [{ value: "original" }]);
					}
					if (mode === "cleanup-failed") yield* sql`DROP TRIGGER fail_cleanup`;
					assert.equal(
						yield* run(
							mode === "append-lost" || mode === "restart-after-ack" || mode === "cleanup-failed"
								? "changed"
								: "original",
						),
						"original",
					);
					assert.deepEqual(
						(yield* events.query({ since: 0, limit: 10 })).items.map(({ seq }) => seq),
						[1, 2, 3],
					);
					assert.equal((yield* events.state).published_through, 3);
					assert.equal((yield* sql`SELECT * FROM outbox WHERE shipped_at IS NULL`).length, 0);
					assert.equal(reservations.length, mode === "restart-after-ack" ? 0 : 1);
					assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
					assert.equal((yield* sql`SELECT * FROM mutation_batches`).length, 1);
					assert.equal(aborts.length, 0);
				} else if (mode === "probe-mutation-rollback-defect") {
					const result = yield* mutate({
						body: (reserve) =>
							Effect.gen(function* () {
								yield* reserve(1);
								yield* sql`INSERT INTO domain VALUES('unconfirmed probe')`;
								return yield* unavailable();
							}),
					}).pipe(Effect.provide(probeLayer), Effect.exit);
					assert.ok(Exit.isFailure(result));
					assert.ok(Cause.hasDies(result.cause));
					assert.ok(result.cause.reasons.some(Cause.isFailReason));
					assert.equal(yield* Ref.get(lifecycle.healthy), true);
					assert.equal(aborts.length, 0);
					assert.equal(reservations.length, 1);
					assert.equal(relays, 0);
					assert.equal((yield* events.state).pending_id, reservations[0]?.transaction);
				} else if (mode === "health-rollback-defect") {
					const dispatch = mutate({
						body: (reserve) =>
							Effect.gen(function* () {
								const range = yield* reserve(1);
								yield* sql`INSERT INTO domain VALUES('unconfirmed probe')`;
								return { outcome: "probe", events: [event(range.from)] };
							}),
					}).pipe(Effect.as(HttpServerResponse.empty({ status: 500 })));
					const result = yield* probeHealth(dispatch).pipe(
						Effect.provideService(SqlClient.SqlClient, mutationSql),
						Effect.provideService(BootChannel, boot),
						Effect.exit,
					);
					assert.ok(Exit.isFailure(result));
					assert.ok(Cause.hasDies(result.cause));
					assert.equal(aborts.length, 0);
					assert.equal(reservations.length, 1);
					assert.equal(relays, 0);
					assert.equal(yield* Ref.get(lifecycle.healthy), true);
					assert.equal((yield* events.state).pending_id, reservations[0]?.transaction);
				} else if (mode === "probe") {
					yield* Effect.gen(function* () {
						const probe = yield* HealthProbe;
						const run = mutate({
							body: (reserve) =>
								Effect.gen(function* () {
									const range = yield* reserve(1);
									yield* sql`INSERT INTO domain VALUES('probe')`;
									return { outcome: "probe", events: [event(range.from)] };
								}),
						});
						const result = yield* sql
							.withTransaction(
								Effect.gen(function* () {
									yield* run;
									const first = (yield* Ref.get(probe.reservations))[0];
									assert.ok(first);
									assert.equal((yield* run.pipe(Effect.result))._tag, "Failure");
									assert.deepEqual(yield* Ref.get(probe.reservations), [first]);
									return yield* unavailable();
								}),
							)
							.pipe(Effect.result);
						assert.equal(result._tag, "Failure");
						yield* assertEmpty;
						assert.equal(relays, 0);
						assert.equal(aborts.length, 0);
						assert.equal(reservations.length, 1);
						const first = (yield* Ref.get(probe.reservations))[0];
						assert.ok(first);
						assert.equal((yield* events.state).pending_id, first.transaction);
						yield* boot.reserve(first.transaction, first.count);
						yield* boot.abort(first.transaction);
					}).pipe(Effect.provide(probeLayer));
				} else if (mode === "recursive") {
					const result = yield* mutate({
						body: () =>
							Effect.gen(function* () {
								yield* sql`INSERT INTO domain VALUES('outer')`;
								return yield* mutate({ body: () => Effect.succeed({ outcome: "inner", events: [] }) }).pipe(
									Effect.map((outcome) => ({ outcome, events: [] })),
								);
							}),
					}).pipe(Effect.timeout("1 second"), Effect.result);
					assert.equal(result._tag, "Failure");
					if (result._tag === "Failure")
						assert.equal(Schema.is(KernelError)(result.failure) && result.failure.code, "input_invalid");
					yield* assertEmpty;
					assert.equal(relays, 1);
				} else {
					if (mode === "stale-epoch") yield* sql`UPDATE kernel_writer SET epoch='replacement'`;
					const result = yield* mutate({
						idempotency: receipt,
						body: (reserve) =>
							Effect.gen(function* () {
								yield* sql`INSERT INTO domain VALUES('unacknowledged')`;
								if (mode === "caught-reserve") {
									yield* reserve(2).pipe(Effect.orElseSucceed(() => ({ from: 0, to: 1 })));
									return { outcome: "invalid", events: [] };
								}
								const range = yield* reserve(2);
								if (mode === "caught-second-reserve") yield* reserve(1).pipe(Effect.orElseSucceed(() => range));
								// A typed body failure exercises the failing ROLLBACK finalizer.
								if (mode === "rollback-defect") {
									return yield* unavailable();
								}
								return {
									outcome: "invalid",
									events: [event(range.from), event(mode === "event-mismatch" ? range.from : range.to)],
								};
							}),
					}).pipe(Effect.exit);
					assert.ok(Exit.isFailure(result));
					if (mode.endsWith("commit-defect") || mode.endsWith("rollback-defect"))
						assert.ok(Cause.hasDies(result.cause));
					if (mode !== "commit-defect" && mode !== "rollback-defect") yield* assertEmpty;
					if (mode === "reserve-lost") {
						assert.equal(reservations.length, 2);
						assert.deepEqual(reservations[0], reservations[1]);
						assert.deepEqual(aborts, [reservations[0]?.transaction]);
						assert.equal((yield* events.state).pending_id, null);
					} else if (mode === "stale-epoch") {
						assert.equal(reservations.length, 0);
						assert.equal(aborts.length, 0);
					} else {
						assert.equal(aborts.length, 0);
						assert.equal((yield* events.state).pending_id, reservations[0]?.transaction);
					}
				}
				yield* Console.log("MUTATION_VERIFIED");
			}).pipe(Effect.provide(SqliteClient.layer({ filename: boot.filename, disableWAL: true })));
		}).pipe(Effect.provide(eventsLayer(Effect.void)));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(lifecycleLayer, BunServices.layer)));
program.pipe(BunRuntime.runMain);
