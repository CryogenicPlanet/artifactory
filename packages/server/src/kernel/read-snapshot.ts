import { Context, Effect, Option, type Semaphore } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { KernelError } from "./boot-channel.ts";
import { assertWriterHealthy } from "./lifecycle.ts";
import { assertSqlPublished } from "./sql-publication.ts";
import { HealthProbe } from "./health-probe.ts";

class ReadFence extends Context.Service<ReadFence, number>()("comms/server/ReadFence") {}

/** Nested readers reuse the outer snapshot; a move cannot become visible before its append. */
export const makeReadSnapshot =
	<RelayError, FenceError>(
		sql: SqlClient,
		epoch: string,
		mutex: Semaphore.Semaphore,
		fence: Effect.Effect<{ readonly published_through: number }, FenceError>,
		relay: Effect.Effect<void, RelayError>,
	) =>
	<A, E, R>(read: (fence: number) => Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			const enclosing = yield* Effect.serviceOption(ReadFence);
			if (Option.isSome(enclosing)) return yield* read(enclosing.value);
			if (
				Option.isSome(yield* Effect.serviceOption(sql.transactionService)) &&
				Option.isNone(yield* Effect.serviceOption(HealthProbe))
			)
				return yield* new KernelError({ code: "input_invalid" });
			const snapshot = sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`SELECT epoch FROM kernel_writer`;
					const ceiling = (yield* fence).published_through;
					if (Option.isNone(yield* Effect.serviceOption(HealthProbe))) yield* assertSqlPublished(sql, epoch, ceiling);
					return yield* read(ceiling).pipe(Effect.provideService(ReadFence, ceiling));
				}),
			);
			if (Option.isSome(yield* Effect.serviceOption(HealthProbe))) return yield* snapshot;
			return yield* mutex.withPermit(
				Effect.gen(function* () {
					yield* assertWriterHealthy;
					// Ordinary versioned rows retain their published image. Path rewrites do not.
					const moving =
						yield* sql`SELECT seq FROM outbox WHERE shipped_at IS NULL AND json_extract(event,'$.type') IN ('topic.moved','topic.pages_moved') LIMIT 1`;
					if (moving.length) yield* relay;
					return yield* snapshot;
				}),
			);
		});
