import { Context, Crypto, Effect, Layer, Option, Ref, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel } from "./boot-channel.ts";
import { HealthProbe } from "./health-probe.ts";
import { assertWriterHealthy } from "./lifecycle.ts";
import { assertSqlPublished } from "./sql-publication.ts";
import { makeReadSnapshot } from "./read-snapshot.ts";
import { makeOutboxRelay } from "./outbox.ts";
import { makeMutate } from "./mutate.ts";
import { recordOperationalEvent, type OperationalEvent } from "./operational-events.ts";
import { writeSql } from "./sql-write.ts";
import type { SqlInput } from "./sql-read.ts";
import type { Identity } from "./identity.ts";

/** One instance owns all app mutation, read and outbox serialization, including extension jobs. */
const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const boot = yield* BootChannel;
	const crypto = yield* Crypto.Crypto;
	const mutex = yield* Semaphore.make(1);
	const relay = makeOutboxRelay(sql, boot);
	const mutate = makeMutate(sql, crypto, boot, relay, mutex);
	const fence = Effect.gen(function* () {
		const probe = Option.getOrNull(yield* Effect.serviceOption(HealthProbe));
		if (probe) return { published_through: yield* Ref.get(probe.ceiling) };
		const value = yield* boot.fence;
		yield* assertSqlPublished(sql, boot.epoch, value.published_through);
		return value;
	});
	const read = makeReadSnapshot(sql, boot.epoch, mutex, fence, relay);
	return {
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
		quiesce: mutex.withPermit(Effect.void),
		changed: boot.changed,
	};
});
export class Publication extends Context.Service<Publication, Effect.Success<typeof make>>()(
	"comms/server/Publication",
) {}
export const layer = Layer.effect(Publication, make);
