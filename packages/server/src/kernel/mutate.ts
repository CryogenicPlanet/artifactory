import { Cause, type Crypto, Effect, Option, Ref, Schema, type Semaphore } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type BootChannel, EventRecord, KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";
import { HealthProbe } from "./health-probe.ts";
import { assertWriterHealthy, poisonUncertainWriter } from "./lifecycle.ts";
import { lookupIdempotency, storeIdempotency, type Idempotency } from "./idempotency.ts";

type Range = { readonly from: number; readonly to: number };
export interface Mutation<A, E, R> {
	readonly idempotency?: Idempotency<A>;
	readonly guard?: Effect.Effect<void, E, R>;
	readonly body: (reserve: (count: number) => Effect.Effect<Range, KernelError>) => Effect.Effect<
		{
			readonly outcome: A;
			readonly events: ReadonlyArray<typeof EventRecord.Type>;
		},
		E,
		R
	>;
}

/** One writer permit covers the SQL commit and publication. Only confirmed rollback can abort a reservation. */
export const makeMutate =
	<RelayError>(
		sql: SqlClient,
		crypto: Crypto.Crypto,
		boot: BootChannel["Service"],
		relay: Effect.Effect<void, RelayError>,
		mutex: Semaphore.Semaphore,
	) =>
	<A, E, R>(input: Mutation<A, E, R>) =>
		Effect.gen(function* () {
			const probe = Option.getOrNull(yield* Effect.serviceOption(HealthProbe));
			const enclosing = yield* Effect.serviceOption(sql.transactionService);
			// Reject before the semaphore: recursive mutations would deadlock before entering SQL.
			if (Option.isSome(enclosing) && (!probe || enclosing.value[1] !== 0))
				return yield* new KernelError({ code: "input_invalid" });
			return yield* mutex.withPermit(
				Effect.gen(function* () {
					if (!probe) yield* assertWriterHealthy;
					if (input.guard) yield* input.guard;
					if (!probe) yield* relay;
					const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
					let count = 0;
					let range: Range | undefined;
					let invalidReservation = false;
					const reserve = (requested: number) =>
						Effect.gen(function* () {
							if (
								count !== 0 ||
								!Number.isSafeInteger(requested) ||
								requested < 1 ||
								(probe && (yield* Ref.get(probe.reservations)).length >= (probe.allowMultiple ? 256 : 1))
							) {
								invalidReservation = true;
								return yield* new KernelError({ code: "input_invalid" });
							}
							count = requested;
							if (probe) yield* Ref.update(probe.reservations, (items) => [...items, { transaction, count }]);
							range = yield* boot.reserve(transaction, count);
							if (range.to - range.from + 1 !== count) return yield* Effect.die("Invalid boot reservation range");
							if (probe) yield* Ref.set(probe.ceiling, range.to);
							return range;
						});
					const result = yield* sql
						.withTransaction(
							Effect.gen(function* () {
								yield* writerGate(sql, boot.epoch);
								if (input.idempotency) {
									const receipt = yield* lookupIdempotency(sql, crypto, input.idempotency);
									if (Option.isSome(receipt)) return receipt.value;
								}
								const written = yield* input.body(reserve);
								// A swallowed reservation failure cannot turn a partially reserved mutation into a success.
								if (
									invalidReservation ||
									(count > 0 && !range) ||
									written.events.length !== count ||
									written.events.some(
										(event, index) =>
											!range || event.seq !== range.from + index || event.generation !== boot.generation,
									)
								)
									return yield* Effect.die("Mutation events do not match their reservation");
								if (range) {
									yield* sql`INSERT INTO mutation_batches VALUES(${transaction},${range.from},${range.to},${count})`;
									for (const event of written.events) {
										const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(EventRecord))(event);
										yield* sql`INSERT INTO outbox VALUES(${event.seq},${transaction},${encoded},NULL)`;
									}
								}
								if (input.idempotency) yield* storeIdempotency(sql, crypto, input.idempotency, written.outcome);
								return written.outcome;
							}),
						)
						.pipe(Effect.exit);
					if (result._tag === "Failure") {
						// A rollback failure can contain both Fail and Die. Preserve the entire cause before resolving anything.
						if (result.cause.reasons.length === 0 || !result.cause.reasons.every(Cause.isFailReason)) {
							// Preserve uncertain transaction evidence. The keeper must close this
							// connection before recovery decides whether to publish or abort.
							yield* poisonUncertainWriter(result.cause);
							return yield* Effect.failCause(result.cause);
						}
						if (!probe && count > 0) {
							yield* boot.reserve(transaction, count);
							yield* boot.abort(transaction);
						}
						return yield* Effect.failCause(result.cause);
					}
					if (!probe) yield* relay;
					return result.value;
				}).pipe(Effect.uninterruptible),
			);
		});

export type Mutate = ReturnType<typeof makeMutate<KernelError | SqlError | Schema.SchemaError>>;
