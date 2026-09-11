import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Fiber, Layer, Ref, Schema } from "effect";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { EventError, Events, layer } from "../../src/events.ts";

Effect.gen(function* () {
	yield* initializeBootSchema;
	yield* Effect.gen(function* () {
		const events = yield* Events;
		const event = {
			at: 0,
			type: "generation.live",
			level: "info" as const,
			actor: "boot",
			instance: null,
			generation: 1,
			request_id: null,
			topic: null,
			message_id: null,
			payload: {},
		};
		const first = yield* events.changed(0).pipe(Effect.forkScoped);
		yield* Effect.yieldNow;
		yield* events.writeBoot(event);
		const results = [yield* Fiber.join(first)];
		yield* events.reserve("pending", 1, "epoch");
		const completed = yield* Ref.make(false);
		const second = yield* events.changed(1).pipe(
			Effect.tap(() => Ref.set(completed, true)),
			Effect.forkScoped,
		);
		yield* events.writeBoot(event);
		// Higher boot events cannot wake a published-fence waiter through an unresolved app reservation.
		yield* Effect.yieldNow;
		if (yield* Ref.get(completed)) return yield* Effect.die("Published an unresolved reservation");
		yield* events.abort("pending", "epoch");
		results.push(yield* Fiber.join(second));
		// An already completed publication cannot be lost when changed() starts later.
		results.push(yield* events.changed(0));
		const waiting = yield* events.changed(4).pipe(Effect.result, Effect.forkScoped);
		yield* Effect.yieldNow;
		yield* events.stopWaiting;
		for (const result of [yield* Fiber.join(waiting), yield* events.changed(0).pipe(Effect.result)]) {
			if (
				result._tag !== "Failure" ||
				!Schema.is(EventError)(result.failure) ||
				result.failure.code !== "events_unavailable"
			)
				return yield* Effect.die("Shutdown did not close event waits");
		}
		yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Int)))(results));
	}).pipe(Effect.provide(layer(Effect.void)));
}).pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), BunServices.layer)),
	BunRuntime.runMain,
);
