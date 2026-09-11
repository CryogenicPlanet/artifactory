import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Cause, Clock, Console, Duration, Effect, Layer, Logger, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { pruneEvents, retainEvents } from "../../src/event-retention.ts";

const Input = Schema.Struct({ now: Schema.Int, loop: Schema.optionalKey(Schema.Boolean) });
const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const input = yield* Schema.decodeEffect(Schema.fromJsonString(Input))(process.argv[3] ?? "{}");
	const result = yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		const sql = yield* SqlClient.SqlClient;
		const clock = yield* Clock.Clock;
		let hours = 0;
		const work = input.loop ? retainEvents : pruneEvents;
		const exit = yield* work.pipe(
			Effect.provideService(Clock.Clock, {
				currentTimeNanos: clock.currentTimeNanos,
				currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
				monotonicTimeNanos: clock.monotonicTimeNanos,
				monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
				currentTimeMillis: Effect.succeed(input.now),
				currentTimeMillisUnsafe: () => input.now,
				sleep: (duration) => {
					if (!input.loop || Duration.toMillis(duration) !== 3_600_000) return clock.sleep(duration);
					return Effect.gen(function* () {
						hours++;
						if (hours === 1) {
							// Repair invalid policy between ticks; a failed maintenance pass must retry.
							yield* sql`DELETE FROM settings WHERE key='event_retention'`.pipe(Effect.orDie);
						} else return yield* Effect.interrupt;
					});
				},
			}),
			Effect.exit,
		);
		return {
			exit: exit._tag,
			interrupted: exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause),
			hours,
			deleted: exit._tag === "Success" ? exit.value : null,
		};
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result));
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, Logger.layer([]))));
main.pipe(BunRuntime.runMain);
