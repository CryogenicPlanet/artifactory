import { Cause, Context, Crypto, Effect, Layer, Option, Queue, Ref, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel } from "./boot-channel.ts";
import { HealthProbe } from "./health-probe.ts";
import { assertWriterHealthy } from "./lifecycle.ts";
import { assertSqlPublished } from "./sql-publication.ts";
import { makeReadSnapshot } from "./read-snapshot.ts";
import { makeOutboxRelay } from "./outbox.ts";
import { makeMutate, type Mutation } from "./mutate.ts";
import { recordOperationalEvent, type OperationalEvent } from "./operational-events.ts";
import { writeSql } from "./sql-write.ts";
import type { SqlInput } from "./sql-input.ts";
import type { Identity } from "./identity.ts";

/** One instance owns app mutation, snapshot admission and outbox serialization, including extension jobs. */
const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const boot = yield* BootChannel;
	const crypto = yield* Crypto.Crypto;
	const mutex = yield* Semaphore.make(1);
	const pending = yield* Queue.dropping<void>(1);
	const wake = Queue.offer(pending, undefined).pipe(Effect.asVoid);
	const relay = makeOutboxRelay(sql, boot, wake);
	const apply = makeMutate(sql, crypto, boot, relay, mutex);
	const mutate = <A, E, R>(input: Mutation<A, E, R>) => apply(input).pipe(Effect.ensuring(wake));
	const fence = Effect.gen(function* () {
		const probe = Option.getOrNull(yield* Effect.serviceOption(HealthProbe));
		if (probe) return { published_through: yield* Ref.get(probe.ceiling) };
		const value = yield* boot.fence;
		yield* assertSqlPublished(sql, boot.epoch, value.published_through);
		return value;
	});
	const { read, quiesce } = yield* makeReadSnapshot(sql, boot.epoch, mutex, fence, relay, yield* Effect.scope);
	return {
		wake,
		runRelay: <E, R>(pass: Effect.Effect<void, E, R>) =>
			Effect.gen(function* () {
				yield* wake;
				let retry = 0;
				while (true) {
					// Receipt expiry still needs maintenance when no new local work arrives.
					if (retry === 0) yield* Queue.take(pending).pipe(Effect.timeoutOption("30 seconds"));
					else yield* Effect.sleep(retry);
					const result = yield* pass.pipe(Effect.exit);
					if (result._tag === "Success") retry = 0;
					else {
						if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.interrupt;
						// A pending append may never advance boot.changed; retry without a new signal.
						retry = Math.min(retry === 0 ? 100 : retry * 2, 2000);
					}
				}
			}),
		mutate,
		read,
		fence,
		writeSql: (who: Identity, input: typeof SqlInput.Type, key?: string) =>
			writeSql(sql, mutate, crypto, boot, who, input, key),
		change: <A, E, R>(change: Effect.Effect<A, E, R>) =>
			mutate({ body: () => change.pipe(Effect.map((outcome) => ({ outcome, events: [] }))) }),
		recordEvent: <E = never>(input: OperationalEvent, change?: (seq: number) => Effect.Effect<void, E>) =>
			recordOperationalEvent(mutate, boot, input, change),
		relay: mutex.withPermit(assertWriterHealthy.pipe(Effect.andThen(relay))),
		quiesce,
		changed: boot.changed,
	};
});
export class Publication extends Context.Service<Publication, Effect.Success<typeof make>>()(
	"comms/server/Publication",
) {}
export const layer = Layer.effect(Publication, make);
