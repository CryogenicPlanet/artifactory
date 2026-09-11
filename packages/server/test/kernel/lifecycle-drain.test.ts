import { Effect, Fiber, Ref } from "effect";
import { expect, it } from "@effect/vitest";
import { Lifecycle, layer } from "../../src/kernel/lifecycle.ts";

it.effect("wakes all drain waiters and distinguishes frozen mutations from draining requests", () =>
	Effect.gen(function* () {
		const lifecycle = yield* Lifecycle;
		yield* Ref.set(lifecycle.requests, 1);
		yield* Ref.set(lifecycle.mutations, 1);
		const frozen = yield* lifecycle.awaitIdle(false).pipe(Effect.forkChild);
		const drained = yield* lifecycle.awaitIdle(true).pipe(Effect.forkChild);
		const sibling = yield* lifecycle.awaitIdle(true).pipe(Effect.forkChild);
		yield* Effect.yieldNow;
		yield* Ref.set(lifecycle.mutations, 0);
		yield* lifecycle.activityChanged;
		yield* Fiber.join(frozen);
		expect(drained.pollUnsafe()).toBeUndefined();
		expect(sibling.pollUnsafe()).toBeUndefined();
		yield* Ref.set(lifecycle.requests, 0);
		yield* lifecycle.activityChanged;
		yield* Fiber.join(drained);
		yield* Fiber.join(sibling);
		// Completion may win before a waiter starts; a past notification is not required to finish.
		for (let attempt = 0; attempt < 100; attempt++) {
			yield* Ref.set(lifecycle.requests, 1);
			const complete = Ref.set(lifecycle.requests, 0).pipe(Effect.andThen(lifecycle.activityChanged));
			yield* Effect.all([lifecycle.awaitIdle(true), complete], { concurrency: "unbounded" });
		}
	}).pipe(Effect.provide(layer)),
);
