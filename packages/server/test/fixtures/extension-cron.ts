import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Config, Console, Effect, Ref, Layer, Schema, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { BootChannel } from "../../src/kernel/boot-channel.ts";
import { layer as messagesLayer } from "../../src/kernel/messages.ts";
import { Lifecycle, layer as lifecycleLayer, type State } from "../../src/kernel/lifecycle.ts";
import { Extensions, layer as extensionsLayer } from "../../src/kernel/ext.ts";

const run = Effect.gen(function* () {
	const directory = yield* Config.String("EXTENSION_DIRECTORY");
	return yield* Effect.gen(function* () {
		const extensions = yield* Extensions;
		const lifecycle = yield* Lifecycle;
		const changeState = (state: State) =>
			Ref.set(lifecycle.state, state).pipe(Effect.andThen(extensions.changeState(state)));
		yield* TestClock.setTime(0);
		for (const state of ["rehearsal", "candidate", "accepted"] as const) {
			yield* changeState(state);
			yield* TestClock.adjust("2 minutes");
		}
		yield* changeState("live");
		yield* TestClock.adjust("1 minute");
		yield* changeState("live");
		yield* TestClock.adjust("1 minute");
		const freeze = yield* changeState("frozen").pipe(Effect.forkScoped);
		yield* TestClock.adjust("3 minutes");
		yield* Fiber.join(freeze);
		yield* changeState("live");
		yield* TestClock.adjust("1 minute");
		yield* changeState("draining");
		yield* TestClock.adjust("3 minutes");
		yield* Console.log(
			yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
				status: yield* extensions.status,
				diagnostics: (yield* extensions.diagnostics).map(({ transaction, type, level, payload }) => ({
					transaction,
					type,
					level,
					payload,
				})),
			}),
		);
	}).pipe(Effect.provide(extensionsLayer(directory).pipe(Layer.provide(messagesLayer))));
}).pipe(
	Effect.scoped,
	Effect.provideService(BootChannel, {
		epoch: "test",
		filename: ":memory:",
		generation: 1,
		agents: Effect.succeed({ items: [] }),
		fence: Effect.succeed({ published_through: 0 }),
		events: (input) => Effect.succeed({ items: [], cursor: input.since, timed_out: false, drained: false }),
		reserve: (transaction, count) => Effect.succeed({ transaction, from: 1, to: count }),
		abort: () => Effect.void,
		append: () => Effect.succeed({ published_through: 0 }),
	}),
	Effect.provide(
		Layer.mergeAll(lifecycleLayer, TestClock.layer(), SqliteClient.layer({ filename: ":memory:" }), BunServices.layer),
	),
);
run.pipe(BunRuntime.runMain);
