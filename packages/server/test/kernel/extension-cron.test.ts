import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { parseCron, runCron } from "../../src/kernel/extension-cron.ts";

it.effect("waits for the next UTC tick, runs serially, and skips missed ticks", () =>
	Effect.gen(function* () {
		yield* TestClock.setTime(0);
		const trace = yield* Ref.make<ReadonlyArray<number>>([]);
		const release = yield* Deferred.make<void>();
		const fiber = yield* runCron(parseCron("* * * * *"), (at) =>
			Ref.update(trace, (items) => [...items, at]).pipe(Effect.andThen(Deferred.await(release))),
		).pipe(Effect.forkScoped);
		yield* TestClock.adjust("59 seconds");
		expect(yield* Ref.get(trace)).toEqual([]);
		yield* TestClock.adjust("1 second");
		expect(yield* Ref.get(trace)).toEqual([60000]);
		yield* TestClock.adjust("150 seconds");
		expect(yield* Ref.get(trace)).toEqual([60000]);
		yield* Deferred.succeed(release, undefined);
		yield* TestClock.adjust("29 seconds");
		expect(yield* Ref.get(trace)).toEqual([60000]);
		yield* TestClock.adjust("1 second");
		expect(yield* Ref.get(trace)).toEqual([60000, 240000]);
		yield* Fiber.interrupt(fiber);
		yield* TestClock.adjust("5 minutes");
		expect(yield* Ref.get(trace)).toEqual([60000, 240000]);
	}),
);

it("rejects malformed and impossible schedules during registration", () => {
	for (const expression of ["* * * * * *", "bad", "0 0 31 2 *", "60 * * * *"]) {
		expect(() => parseCron(expression)).toThrow();
	}
	expect(() => parseCron("0 9 * * MON-FRI")).not.toThrow();
});
