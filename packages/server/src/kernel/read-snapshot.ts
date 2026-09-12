import { jsonText, on, readTransaction } from "@comms/storage/dialect";
import { Cause, Context, Deferred, Effect, Fiber, Option, Ref, type Scope, type Semaphore } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { KernelError } from "./boot-channel.ts";
import { Lifecycle, assertWriterHealthy, poisonUncertainWriter } from "./lifecycle.ts";
import { assertSqlPublished } from "./sql-publication.ts";
import { HealthProbe } from "./health-probe.ts";

class ReadFence extends Context.Service<ReadFence, number>()("comms/server/ReadFence") {}

/** Nested readers reuse the outer snapshot; a move cannot become visible before its append. */
export const makeReadSnapshot = <RelayError, FenceError>(
	sql: SqlClient,
	epoch: string,
	mutex: Semaphore.Semaphore,
	fence: Effect.Effect<{ readonly published_through: number }, FenceError>,
	relay: Effect.Effect<void, RelayError>,
	scope: Scope.Scope,
) =>
	Effect.gen(function* () {
		const active = yield* Ref.make<readonly Deferred.Deferred<void>[]>([]);
		const readSnapshot = <A, E, R>(read: (fence: number) => Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				const enclosing = yield* Effect.serviceOption(ReadFence);
				if (Option.isSome(enclosing)) return yield* read(enclosing.value);
				if (
					Option.isSome(yield* Effect.serviceOption(sql.transactionService)) &&
					Option.isNone(yield* Effect.serviceOption(HealthProbe))
				)
					return yield* new KernelError({ code: "input_invalid" });
				const snapshot = (afterPin: Effect.Effect<void>) =>
					readTransaction(
						sql,
						Effect.gen(function* () {
							yield* sql`SELECT epoch FROM kernel_writer`;
							const ceiling = (yield* fence).published_through;
							if (Option.isNone(yield* Effect.serviceOption(HealthProbe)))
								yield* assertSqlPublished(sql, epoch, ceiling);
							yield* afterPin;
							return yield* read(ceiling).pipe(Effect.provideService(ReadFence, ceiling));
						}),
					).pipe(
						Effect.onExit((exit) =>
							exit._tag === "Failure" && Cause.hasDies(exit.cause) ? poisonUncertainWriter(exit.cause) : Effect.void,
						),
					);
				if (Option.isSome(yield* Effect.serviceOption(HealthProbe))) return yield* snapshot(Effect.void);
				const lifecycle = Option.getOrNull(yield* Effect.serviceOption(Lifecycle));
				const ownership = yield* Ref.make<"waiting" | "held" | "escalated" | "done">("waiting");
				const poison = lifecycle ? Ref.set(lifecycle.healthy, false) : Effect.void;
				// Absolute budget from invocation, including permit wait: three seconds plus one for cleanup.
				// A service-owned fiber survives caller cancellation without releasing its database ownership.
				const guard = Effect.sleep("4 seconds").pipe(
					Effect.andThen(
						Effect.gen(function* () {
							const claimed = yield* Ref.modify(
								ownership,
								(state) => [state === "held", state === "held" ? "escalated" : state] as const,
							);
							if (claimed) yield* poison;
						}),
					),
				);
				const complete = yield* Deferred.make<void>();
				const permitHeld = yield* Ref.make(false);
				const releasePermit = Ref.getAndSet(permitHeld, false).pipe(
					Effect.flatMap((held) => (held ? mutex.release(1).pipe(Effect.asVoid) : Effect.void)),
					Effect.uninterruptible,
				);
				const operation = Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						yield* restore(mutex.take(1));
						yield* Ref.set(permitHeld, true);
						yield* Ref.set(ownership, "held");
						yield* Ref.update(active, (reads) => [...reads, complete]);
						return yield* restore(
							Effect.gen(function* () {
								yield* assertWriterHealthy;
								// Ordinary versioned rows retain their published image. Path rewrites do not.
								const moving =
									yield* sql`SELECT seq FROM outbox WHERE shipped_at IS NULL AND ${jsonText(sql, sql("event"), "type")} IN ('topic.moved','topic.pages_moved') LIMIT 1`;
								if (moving.length) yield* relay;
								// Remote snapshots retain their lease after admission; SQLite retains the permit too.
								return yield* snapshot(
									on(sql, { sqlite: () => Effect.void, pg: () => releasePermit, mysql: () => releasePermit }),
								);
							}),
						).pipe(
							Effect.ensuring(
								Effect.gen(function* () {
									// Transaction cleanup and poisoning finish before quiesce can observe completion.
									if ((yield* Ref.getAndSet(ownership, "done")) === "escalated") yield* poison;
									yield* Ref.update(active, (reads) => reads.filter((read) => read !== complete));
									yield* Deferred.succeed(complete, undefined);
								}),
							),
						);
					}),
				).pipe(Effect.ensuring(releasePermit));
				const interrupted = yield* Ref.make<Cause.Cause<Effect.Error<typeof operation>> | null>(null);
				return yield* Effect.acquireUseRelease(guard.pipe(Effect.forkIn(scope)), () => operation, Fiber.interrupt).pipe(
					// The timeout race awaits cleanup but discards its exit. Retain defects before returning a timeout.
					Effect.onExit((exit) => (exit._tag === "Failure" ? Ref.set(interrupted, exit.cause) : Effect.void)),
					Effect.timeoutOrElse({
						duration: "3 seconds",
						orElse: () =>
							Effect.gen(function* () {
								const cause = yield* Ref.get(interrupted);
								if (cause && !Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
								return yield* new KernelError({ code: "read_snapshot_timeout" });
							}),
					}),
					// Admission and its deadline remain cancelable even if the caller masks the whole read.
					Effect.interruptible,
				);
			});
		return {
			read: readSnapshot,
			quiesce: mutex.withPermit(
				Ref.get(active).pipe(Effect.flatMap((reads) => Effect.forEach(reads, Deferred.await, { discard: true }))),
			),
		};
	});
